import { abortAllDurableObjects } from "cloudflare:test";
import {
    COMPUTER_SUCCESSOR_CREDENTIAL_HEADER,
    computerCredentialSuccessor,
    type NativeSessionTarget,
} from "@morty-build/client/protocol";
import * as v from "valibot";
import { afterAll, afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { closeBrowserSocket } from "./browser-session.ts";
import { createOwner, issueSession, ownerOrigin, ownerRequest, pairComputer } from "./owner-fixture.ts";

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: new Date("2030-01-01T00:00:00Z") }));
afterEach(() => vi.useRealTimers());
afterAll(() => abortAllDurableObjects());

class Inbox {
    readonly #pending: PromiseWithResolvers<unknown>[] = [];
    readonly #queued: unknown[] = [];
    constructor(socket: WebSocket) {
        socket.addEventListener("message", (event) => {
            const message: unknown = JSON.parse(String(event.data));
            const pending = this.#pending.shift();
            if (pending === undefined) {
                this.#queued.push(message);
            } else {
                pending.resolve(message);
            }
        });
        socket.addEventListener("close", () => {
            for (const pending of this.#pending.splice(0)) {
                pending.reject(new Error("Connection closed"));
            }
        });
    }
    readonly next = (): Promise<unknown> => {
        const queued = this.#queued.shift();
        if (queued !== undefined) {
            return Promise.resolve(queued);
        }
        const pending = Promise.withResolvers<unknown>();
        this.#pending.push(pending);
        return pending.promise;
    };
}

async function connectedComputer() {
    const { computerId } = await createOwner();
    const credential = await pairComputer(computerId);
    const connected = await ownerRequest(
        new Request(`${ownerOrigin}/morty/api/v1/computers/connect`, {
            headers: {
                Upgrade: "websocket",
                authorization: `Bearer ${credential}`,
                [COMPUTER_SUCCESSOR_CREDENTIAL_HEADER]: computerCredentialSuccessor(credential),
            },
        }),
    );
    expect(connected.status).toBe(101);
    const daemon = connected.webSocket;
    if (daemon === null) {
        throw new Error("Expected the paired daemon connection");
    }
    const daemonInbox = new Inbox(daemon);
    daemon.accept();
    onTestFinished(() => daemon.close(1000, "Test complete"));
    expect(await daemonInbox.next()).toEqual({ kind: "computer.liveness.ready" });
    return {
        daemon,
        subscribe: async (target: NativeSessionTarget) => {
            const { credential } = await issueSession(computerId, target);
            const response = await ownerRequest(
                new Request(`${ownerOrigin}/morty/api/v1/computers/${computerId}/transport`, {
                    headers: { Upgrade: "websocket" },
                }),
            );
            expect(response.status).toBe(101);
            const socket = response.webSocket;
            if (socket === null) {
                throw new Error("Expected the browser transport");
            }
            const inbox = new Inbox(socket);
            socket.accept();
            onTestFinished(() => closeBrowserSocket(socket, new AbortController().signal));
            socket.send(
                JSON.stringify({
                    kind: "session.events.subscribe",
                    subscriptionId: "events",
                    path: `/morty/api/v1/computers/${computerId}/harnesses/${target.harness}/sessions/${target.sessionId}/events`,
                    headers: [["authorization", `Bearer ${credential}`]],
                }),
            );
            expect(await inbox.next()).toMatchObject({ kind: "session.events.ready" });
            return inbox;
        },
    };
}

const event = (target: NativeSessionTarget, id: string) => ({
    eventId: id,
    position: "1",
    recordedAt: "2030-01-01T00:00:00Z",
    sessionGenerationId: "generation-1",
    target,
    type: "acp",
    futureField: { preserved: true },
    payload: { sessionUpdate: "future_update", content: { type: "future_content", text: id } },
});

it("Given viewers of two native Session pairs, When the daemon emits a mixed batch with unknown content, Then each browser receives only its Session with every field preserved", async () => {
    const computer = await connectedComputer();
    const first = { harness: "claude", sessionId: "shared-id" };
    const second = { harness: "codex", sessionId: "shared-id" };
    const firstInbox = await computer.subscribe(first);
    const secondInbox = await computer.subscribe(second);
    const firstEvent = event(first, "first-event");
    const secondEvent = event(second, "second-event");
    computer.daemon.send(JSON.stringify({ kind: "session.event.v2", events: [firstEvent, secondEvent] }));
    for (const [inbox, expected] of [
        [firstInbox, firstEvent],
        [secondInbox, secondEvent],
    ] as const) {
        const received = v.parse(
            v.object({ kind: v.literal("session.events.event"), data: v.string() }),
            await inbox.next(),
        );
        expect(JSON.parse(received.data)).toEqual([expected]);
    }
});

it("Given two live Session views, When the daemon closes one Session, Then that subscription reports session_closed and the other continues receiving output", async () => {
    const computer = await connectedComputer();
    const closed = { harness: "claude", sessionId: "closed-session" };
    const open = { harness: "claude", sessionId: "open-session" };
    const closedInbox = await computer.subscribe(closed);
    const openInbox = await computer.subscribe(open);
    computer.daemon.send(JSON.stringify({ kind: "session.close.notice", target: closed, reason: "Session released" }));
    expect(await closedInbox.next()).toMatchObject({
        kind: "session.events.error",
        code: "session_closed",
        status: 409,
        message: "Session released",
    });
    const output = event(open, "still-open");
    computer.daemon.send(JSON.stringify({ kind: "session.event.v2", events: [output] }));
    const received = v.parse(
        v.object({ kind: v.literal("session.events.event"), data: v.string() }),
        await openInbox.next(),
    );
    expect(JSON.parse(received.data)).toEqual([output]);
});
