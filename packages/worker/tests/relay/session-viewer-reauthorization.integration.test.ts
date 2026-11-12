import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
    COMPUTER_HEARTBEAT_ACK_MESSAGE,
    COMPUTER_HEARTBEAT_MESSAGE,
    COMPUTER_SUCCESSOR_CREDENTIAL_HEADER,
    computerCredentialSuccessor,
    MORTY_API_PREFIX,
} from "@morty-build/client/protocol";
import { afterAll, afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createTestMortyRelayApp } from "../../../relay-test-support/src/app.ts";
import { IdentityStorage } from "../../src/computer-relay/components/management/storage/identity-storage.ts";
import { DurableObjectDatabase } from "../../src/computer-relay/infra/durable-object-database.ts";
import { computerObjectName } from "../../src/contracts/computer-id.ts";
import { RelayAuthenticationConfiguration } from "../../src/contracts/relay/computer-management.ts";
import { createOwner, issueSession, ownerRequest, pairComputer } from "./owner-fixture.ts";

const origin = `https://relay.test${MORTY_API_PREFIX}`;

afterAll(async () => await abortAllDurableObjects());
beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-11T00:00:00Z") }));
afterEach(() => vi.useRealTimers());

class Inbox {
    readonly #pending: PromiseWithResolvers<Record<string, unknown>>[] = [];
    readonly #queued: Record<string, unknown>[] = [];
    #closed: { code: number; reason: string } | undefined;
    readonly closed = Promise.withResolvers<{ code: number; reason: string }>();
    constructor(socket: WebSocket) {
        socket.addEventListener("message", (event) => {
            if (event.data === COMPUTER_HEARTBEAT_ACK_MESSAGE) {
                return;
            }
            const message = JSON.parse(String(event.data));
            const pending = this.#pending.shift();
            if (pending === undefined) {
                this.#queued.push(message);
            } else {
                pending.resolve(message);
            }
        });
        socket.addEventListener("close", (event) => {
            this.#closed = { code: event.code, reason: event.reason };
            this.closed.resolve(this.#closed);
            for (const pending of this.#pending.splice(0)) {
                pending.reject(new Error(`closed ${event.code} ${event.reason}`));
            }
        });
    }
    readonly next = (): Promise<Record<string, unknown>> => {
        const message = this.#queued.shift();
        if (message !== undefined) {
            return Promise.resolve(message);
        }
        if (this.#closed !== undefined) {
            return Promise.reject(new Error("closed"));
        }
        const pending = Promise.withResolvers<Record<string, unknown>>();
        this.#pending.push(pending);
        return pending.promise;
    };
}

async function openSessionView(_slug: string) {
    const worker = createTestMortyRelayApp(new RelayAuthenticationConfiguration());
    const owner = await createOwner();
    const { computerId } = owner;
    const sessionId = "viewer-check-session";
    const credential = await pairComputer(computerId);
    const daemonResponse = await ownerRequest(
        new Request(`${origin}/v1/computers/connect`, {
            headers: {
                Upgrade: "websocket",
                authorization: `Bearer ${credential}`,
                [COMPUTER_SUCCESSOR_CREDENTIAL_HEADER]: computerCredentialSuccessor(credential),
            },
        }),
    );
    expect(daemonResponse.status).toBe(101);
    const daemon = daemonResponse.webSocket;
    if (daemon === null) {
        throw new Error("Expected a daemon connection");
    }
    const daemonInbox = new Inbox(daemon);
    daemon.accept();
    expect(await daemonInbox.next()).toEqual({ kind: "computer.liveness.ready" });
    const heartbeat = new Promise<void>((resolve) => {
        const receive = (event: MessageEvent) => {
            if (event.data === COMPUTER_HEARTBEAT_ACK_MESSAGE) {
                daemon.removeEventListener("message", receive);
                resolve();
            }
        };
        daemon.addEventListener("message", receive);
    });
    daemon.send(COMPUTER_HEARTBEAT_MESSAGE);
    await heartbeat;
    vi.setSystemTime(
        await runInDurableObject(env.COMPUTER_RELAY.getByName(computerObjectName(computerId)), (_instance, state) => {
            const socket = state.getWebSockets("daemon")[0];
            const answeredAt = socket === undefined ? null : state.getWebSocketAutoResponseTimestamp(socket);
            if (answeredAt === null) {
                throw new Error("Expected the daemon heartbeat timestamp");
            }
            return answeredAt.getTime();
        }),
    );

    const { credential: sessionCredential } = await issueSession(computerId, { harness: "claude", sessionId });

    const opened = await worker.fetch(
        new Request(`${origin}/v1/computers/${computerId}/transport`, {
            headers: { Upgrade: "websocket" },
        }),
        env,
    );
    expect(opened.status).toBe(101);
    const view = opened.webSocket;
    if (view === null) {
        throw new Error("Expected a live Session view");
    }
    const viewInbox = new Inbox(view);
    view.accept();
    onTestFinished(() => view.close(1000, "Test complete"));
    view.send(
        JSON.stringify({
            kind: "session.events.subscribe",
            subscriptionId: "viewer-reauthorization",
            path: `${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/claude/sessions/${sessionId}/events-v2`,
            headers: [["authorization", `Bearer ${sessionCredential}`]],
        }),
    );
    expect(await viewInbox.next()).toMatchObject({ kind: "session.events.ready" });

    return { daemon, owner, computerId, sessionId, viewInbox };
}

const liveEvent = (sessionId: string, eventId: string) => ({
    eventId,
    position: "1",
    recordedAt: new Date().toISOString(),
    sessionGenerationId: "generation-1",
    target: { harness: "claude", sessionId: sessionId },
    type: "acp",
    payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "secret output" } },
});

it("Given a live Session view, When the owner revokes browser access, Then the live view closes", async () => {
    const { daemon, owner, computerId, sessionId, viewInbox } = await openSessionView("app");
    daemon.send(JSON.stringify({ kind: "session.event.v2", events: [liveEvent(sessionId, "before-revocation")] }));
    expect(await viewInbox.next()).toMatchObject({
        kind: "session.events.event",
        data: expect.stringContaining("before-revocation"),
    });

    const revoked = await ownerRequest(
        new Request(`${origin}/computers/${computerId}/identity/revoke-all-access`, {
            method: "POST",
            headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
            body: JSON.stringify({ successor: `morty_computer_v1_${"B".repeat(43)}` }),
        }),
    );
    expect(revoked.status).toBe(200);

    expect(await viewInbox.next()).toMatchObject({
        kind: "session.events.end",
    });
    daemon.close(1000, "done");
});

it("Given a live Session view the revocation push missed, When the Computer's Session access revocation is committed, Then the Relay's next connection check closes the view", async () => {
    const { daemon, owner, computerId, sessionId, viewInbox } = await openSessionView("missed");
    daemon.send(JSON.stringify({ kind: "session.event.v2", events: [liveEvent(sessionId, "before-revocation")] }));
    expect(await viewInbox.next()).toMatchObject({
        kind: "session.events.event",
        data: expect.stringContaining("before-revocation"),
    });

    // The revocation commits, but its push never reaches the view (or reached it before the view opened).
    await runInDurableObject(env.COMPUTER_RELAY.getByName(computerObjectName(computerId)), async (_instance, state) => {
        const signal = AbortSignal.timeout(10_000);
        const identities = new IdentityStorage(new DurableObjectDatabase(state.storage), computerId);
        const credential = await identities.findCredential(owner.token, Date.now(), signal);
        if (credential === null) {
            throw new Error("Expected the owner credential");
        }
        expect(
            await identities.revokeCredential(
                { kind: "local", credentialId: credential.credentialId },
                Date.now(),
                signal,
            ),
        ).toBe(true);
    });
    expect(await runDurableObjectAlarm(env.COMPUTER_RELAY.getByName(computerObjectName(computerId)))).toBe(true);

    expect(await viewInbox.next()).toMatchObject({
        kind: "session.events.end",
    });
    daemon.close(1000, "done");
});
