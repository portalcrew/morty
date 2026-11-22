import { abortAllDurableObjects, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as v from "valibot";
import { afterAll, afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { computerObjectName } from "../../src/contracts/computer-id.ts";
import { createOwner, ownerOrigin, ownerRequest } from "./owner-fixture.ts";

const hour = 60 * 60 * 1000;
const start = Date.parse("2026-11-20T00:00:00.000Z");

afterAll(abortAllDurableObjects);
beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: start }));
afterEach(() => vi.useRealTimers());

class Inbox {
    readonly #queued: unknown[] = [];
    readonly #pending: PromiseWithResolvers<unknown>[] = [];
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

const post = (path: string, token: string, body: object) =>
    ownerRequest(
        new Request(`${ownerOrigin}/morty/api/${path}`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(body),
        }),
    );

async function openLink(
    computerId: string,
    ownerToken: string,
    accessDuration: "1h" | "1d",
    replaces: string | null,
): Promise<string> {
    const shared = await post(`v1/computers/${computerId}/identity/transfers`, ownerToken, {
        operationId: crypto.randomUUID(),
        accessDuration,
    });
    const { url } = v.parse(v.object({ url: v.string() }), await shared.json());
    const redeemed = await post("v1/identity/transfers/redeem", ownerToken, {
        code: new URL(url).hash.slice(6),
        device: "Phone",
        ...(replaces === null ? {} : { replaces }),
    });
    return v.parse(v.object({ computerToken: v.string() }), await redeemed.json()).computerToken;
}

async function followChanges(computerId: string, token: string): Promise<Inbox> {
    const opened = await ownerRequest(
        new Request(`${ownerOrigin}/morty/api/v1/computers/${computerId}/transport`, {
            headers: { Upgrade: "websocket" },
        }),
    );
    const socket = opened.webSocket;
    if (socket === null) {
        throw new Error("Expected the browser transport");
    }
    const inbox = new Inbox(socket);
    socket.accept();
    onTestFinished(() => socket.close(1000, "Test complete"));
    socket.send(JSON.stringify({ kind: "changes.follow", headers: [["authorization", `Bearer ${token}`]] }));
    expect(await inbox.next()).toEqual({ kind: "changes.ready" });
    return inbox;
}

const relay = (computerId: string) => env.COMPUTER_RELAY.getByName(computerObjectName(computerId));

it("Given a browser following its Computer's changes under a one-hour link, When the hour passes, Then it is told its access ended", async ({
    signal,
}) => {
    const owner = await createOwner(signal);
    const device = await openLink(owner.computerId, owner.token, "1h", null);
    vi.setSystemTime(start + hour - 30_000);
    const inbox = await followChanges(owner.computerId, device);

    vi.setSystemTime(start + hour + 1);
    await runDurableObjectAlarm(relay(owner.computerId));

    expect(await inbox.next()).toEqual({
        kind: "changes.error",
        code: "access_ended",
        status: 401,
        message: "This access has ended",
    });
});

it("Given a browser following its Computer's changes under a one-hour link, When it opens a one-day link and the hour passes, Then it keeps following", async ({
    signal,
}) => {
    const owner = await createOwner(signal);
    const device = await openLink(owner.computerId, owner.token, "1h", null);
    vi.setSystemTime(start + hour - 30_000);
    const inbox = await followChanges(owner.computerId, device);
    await openLink(owner.computerId, owner.token, "1d", device);
    expect(await inbox.next()).toEqual({ kind: "changes.changed", topic: "linked-devices" });

    vi.setSystemTime(start + hour + 1);
    await runDurableObjectAlarm(relay(owner.computerId));
    await openLink(owner.computerId, owner.token, "1h", null);

    expect(await inbox.next()).toEqual({ kind: "changes.changed", topic: "linked-devices" });
});
