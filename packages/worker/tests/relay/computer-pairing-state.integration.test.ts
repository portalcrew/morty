import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { MORTY_API_PREFIX } from "@morty-build/client/protocol";
import * as v from "valibot";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestMortyRelayApp } from "../../../relay-test-support/src/app.ts";
import { ComputerDirectoryStorage } from "../../src/computer-relay/components/management/storage/computer-directory-storage.ts";
import { DurableObjectDatabase } from "../../src/computer-relay/infra/durable-object-database.ts";
import { computerObjectName } from "../../src/contracts/computer-id.ts";
import { RelayAuthenticationConfiguration } from "../../src/contracts/relay/computer-management.ts";
import { hashPairingCredential } from "../../src/contracts/relay/pairing.ts";
import { computerBackend, createOwner, ownerRequest } from "./owner-fixture.ts";
import { revokeTestComputer } from "./registered-computer.ts";

const origin = `https://relay.test${MORTY_API_PREFIX}`;
const pairingSchema = v.object({
    expiresAt: v.string(),
    pairingCode: v.string(),
    computerId: v.string(),
});
type Pairing = Readonly<v.InferOutput<typeof pairingSchema>>;

async function responseJson(response: Response, status: number): Promise<unknown> {
    const body: unknown = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(status);
    return body;
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T00:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());
afterAll(async () => await abortAllDurableObjects());

async function computer() {
    const worker = createTestMortyRelayApp(new RelayAuthenticationConfiguration());
    const owner = await createOwner();
    const { computerId } = owner;
    const backend = computerBackend(computerId);
    const stub = env.COMPUTER_RELAY.getByName(computerObjectName(computerId));
    const request = async (path: string, method = "GET", body?: object, token = owner.token) =>
        await worker.fetch(
            new Request(`${origin}${path}`, {
                method,
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
            env,
        );
    const management = (method: string, body?: object) =>
        ownerRequest(
            new Request(`${origin}/v1/computers/${computerId}/pairing`, {
                method,
                headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
        );
    const create = (idempotencyKey: string) => management("POST", { idempotencyKey });
    return {
        computerId,
        create,
        pair: async (key: string): Promise<Pairing> =>
            v.parse(pairingSchema, await responseJson(await create(key), 201)),
        status: async () => management("GET"),
        claim: async (pairing: Pairing, computerName = "Paired computer") =>
            request(`/v1/computers/${pairing.computerId}/pairing/redeem`, "POST", {
                pairingCode: pairing.pairingCode,
                computerName,
                workspaceName: "Computer workspace",
                agents: [],
            }),
        revoke: async () => {
            try {
                await revokeTestComputer(env, computerId, AbortSignal.timeout(10000));
                return new Response(null, { status: 204 });
            } catch {
                return new Response(null, { status: 500 });
            }
        },
        list: async () => Response.json({ computers: await backend.computers(AbortSignal.timeout(10000)) }),
        publish: async (pairing: Pairing, token: string) =>
            request(`/v1/computers/${pairing.computerId}/catalog`, "PUT", { agents: [] }, token),
        storage: async <T>(operation: (storage: DurableObjectStorage) => Promise<T> | T): Promise<T> =>
            runInDurableObject(stub, async (_instance, state) => operation(state.storage)),
        restart: async () => evictDurableObject(stub),
        sql: async (sql: string) =>
            runInDurableObject(stub, async (_instance, state) => {
                state.storage.sql.exec(sql);
            }),
    };
}

it("Given pending reservations at capacity, When their deadline passes without expiry maintenance, Then status reads and new reservations succeed", async () => {
    const app = await computer();
    const first = await app.pair("reservation-0");
    expect(await responseJson(await app.create("over-capacity"), 429)).toMatchObject({
        error: { code: "computer_quota_exceeded" },
    });
    vi.setSystemTime(new Date(first.expiresAt));
    expect(await responseJson(await app.status(), 200)).toEqual({ status: "expired" });
    expect(await responseJson(await app.claim(first), 400)).toMatchObject({ error: { code: "invalid_pairing_code" } });
    expect(await app.pair("replacement")).toMatchObject({ computerId: app.computerId });
    expect(await app.pair("reservation-0")).toEqual(first);
});

it("Given simultaneous retries of one creation, When they commit, Then they share one reservation and occupy the single daemon slot", async () => {
    const app = await computer();
    const [left, right] = await Promise.all([app.pair("same-request"), app.pair("same-request")]);
    expect(left).toEqual(right);
    expect((await app.create("no-place")).status).toBe(429);
});

it("Given a delayed claim, When newer requests have reused expired capacity, Then the claim cannot overbook the Computer", async () => {
    const app = await computer();
    const pairing = await app.pair("delayed-claim");
    const claimTime = Date.now();
    const codeHash = await hashPairingCredential(pairing.pairingCode);
    vi.setSystemTime(new Date(pairing.expiresAt));
    await app.pair("replacement");
    // Execute the original command against the real Computer database after
    // newer transactions, as can happen when a database request is delayed.
    const claimed = await app.storage(async (storage) =>
        new ComputerDirectoryStorage(new DurableObjectDatabase(storage)).claim(
            {
                codeHash,
                daemonHash: await hashPairingCredential("delayed-computer-credential"),
                now: claimTime,
                computerName: "Delayed computer",
                workspaceName: "Delayed workspace",
                agents: "[]",
            },
            new AbortController().signal,
        ),
    );
    expect(claimed).toBe(false);
    expect(await responseJson(await app.status(), 200)).toMatchObject({ status: "pending" });
    expect(await responseJson(await app.list(), 200)).toEqual({ computers: [] });
});

it("Given a claim whose registration cannot commit, When the caller retries after recovery, Then the request is still pending and can be claimed once", async () => {
    const app = await computer();
    const pairing = await app.pair("claim-rollback");
    await app.sql(`CREATE TRIGGER reject_claim BEFORE INSERT ON computer_registrations
        BEGIN SELECT RAISE(ABORT, 'Controlled claim failure'); END`);
    expect((await app.claim(pairing)).status).toBe(500);
    expect(await responseJson(await app.status(), 200)).toMatchObject({ status: "pending" });
    expect(await responseJson(await app.list(), 200)).toEqual({ computers: [] });
    await app.sql("DROP TRIGGER reject_claim");
    const claimed = v.parse(
        v.object({ computerCredential: v.string() }),
        await responseJson(await app.claim(pairing), 200),
    );
    expect((await app.publish(pairing, claimed.computerCredential)).status).toBe(204);
    expect(await responseJson(await app.claim(pairing), 200)).toMatchObject(claimed);
});

it("Given a committed redeem response is lost, When the caller retries after a relay restart, Then the original credential is recovered without changing the registration", async () => {
    const app = await computer();
    const pairing = await app.pair("lost-redeem");
    // Discard the first result before the caller can save its credential.
    const discarded = await app.claim(pairing);
    expect(discarded.status).toBe(200);
    await discarded.body?.cancel();

    await app.restart();

    vi.setSystemTime(new Date(Date.now() + 20_000));
    const response = await responseJson(await app.claim(pairing, "Retry computer"), 200);
    // A retry returns the exact current redemption contract.
    const identity = { computerId: v.string() };
    const credential = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{32,256}$/));
    const computerCredential = v.parse(
        v.strictObject({ ...identity, computerCredential: credential }),
        response,
    ).computerCredential;
    expect(response).toMatchObject({
        computerId: pairing.computerId,
    });
    expect((await app.publish(pairing, computerCredential)).status).toBe(204);
    expect(await responseJson(await app.list(), 200)).toMatchObject({
        computers: [{ computerId: pairing.computerId, computerName: "Paired computer" }],
    });
    expect((await app.revoke()).status).toBe(204);
    expect(await responseJson(await app.claim(pairing), 400)).toMatchObject({
        error: { code: "invalid_pairing_code" },
    });
    expect((await app.publish(pairing, computerCredential)).status).toBe(401);
});

it("Given one available Computer place, When distinct requests compete, Then exactly one reserves it and retries keep the same identity", async () => {
    const app = await computer();
    const responses = await Promise.all([app.create("competitor-a"), app.create("competitor-b")]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 429]);
    const winnerIndex = responses.findIndex((response) => response.status === 201);
    const winner = responses[winnerIndex];
    if (winner === undefined) {
        throw new Error("Expected one successful reservation");
    }
    const pairing = v.parse(pairingSchema, await responseJson(winner, 201));
    const key = winnerIndex === 0 ? "competitor-a" : "competitor-b";
    expect(await app.pair(key)).toEqual(pairing);
    expect(await responseJson(await app.status(), 200)).toMatchObject({ status: "pending" });
});

it("Given a pending pairing, When claims arrive concurrently, Then they return the same credential and its Computer survives the handshake deadline", async () => {
    const app = await computer();
    const pairing = await app.pair("claim-once");
    const responses = await Promise.all([app.claim(pairing), app.claim(pairing)]);
    const results = await Promise.all(responses.map((response) => responseJson(response, 200)));
    expect(results[0]).toEqual(results[1]);
    const { computerCredential } = v.parse(v.object({ computerCredential: v.string() }), results[0]);
    vi.setSystemTime(new Date(Date.parse(pairing.expiresAt) + 1));
    expect(await responseJson(await app.claim(pairing), 400)).toMatchObject({
        error: { code: "invalid_pairing_code" },
    });
    expect(await responseJson(await app.status(), 200)).toMatchObject({ status: "paired", agents: [] });
    expect((await app.publish(pairing, computerCredential)).status).toBe(204);
    expect(await responseJson(await app.list(), 200)).toMatchObject({
        computers: [{ computerId: pairing.computerId }],
    });
    expect((await app.revoke()).status).toBe(204);
    const revoked = await responseJson(await app.status(), 200);
    expect(revoked).toEqual({ status: "revoked", revokedAt: new Date().toISOString() });
    vi.setSystemTime(new Date(Date.now() + 1_000));
    expect((await app.revoke()).status).toBe(204);
    expect(await responseJson(await app.status(), 200)).toEqual(revoked);
    expect(await responseJson(await app.publish(pairing, computerCredential), 401)).toMatchObject({
        error: { code: "unauthorized" },
    });
    expect(await responseJson(await app.list(), 200)).toEqual({ computers: [] });
    expect(await app.pair("claim-once")).toEqual(pairing);
});

it("Given an unclaimed Computer identity, When it is revoked, Then its code cannot claim it and revocation remains visible after expiry", async () => {
    const app = await computer();
    const pairing = await app.pair("cancel-before-claim");
    expect((await app.revoke()).status).toBe(204);
    const revoked = await responseJson(await app.status(), 200);
    expect(revoked).toMatchObject({ status: "revoked" });
    expect(await responseJson(await app.claim(pairing), 400)).toMatchObject({
        error: { code: "invalid_pairing_code" },
    });
    vi.setSystemTime(new Date(pairing.expiresAt));
    expect(await responseJson(await app.status(), 200)).toEqual(revoked);
    expect(await responseJson(await app.list(), 200)).toEqual({ computers: [] });
});

it("Given separate Computers, When they use the same pairing idempotency key, Then each receives its own stable Computer identity", async () => {
    const first = await computer();
    const second = await computer();
    const left = await first.pair("same-key");
    const right = await second.pair("same-key");
    expect(left.computerId).not.toBe(right.computerId);
    expect(await first.pair("same-key")).toEqual(left);
    expect(await second.pair("same-key")).toEqual(right);
});

it("Given a Computer its owner revoked, When the computer is paired again, Then the old daemon credential is not accepted", async () => {
    const app = await computer();
    const original = await app.pair("original");
    const credential = v.object({ computerId: v.string(), computerCredential: v.string() });
    const old = v.parse(credential, await responseJson(await app.claim(original), 200));
    expect(old.computerId).toBe(original.computerId);
    expect((await app.revoke()).status).toBe(204);
    const replacement = await app.pair("replacement");
    const current = v.parse(credential, await responseJson(await app.claim(replacement), 200));
    expect(current.computerId).toBe(replacement.computerId);
    expect(current.computerId).toBe(old.computerId);
    expect(current.computerCredential).not.toBe(old.computerCredential);
    expect((await app.publish(original, old.computerCredential)).status).toBe(401);
    expect((await app.publish(replacement, old.computerCredential)).status).toBe(401);
    expect((await app.publish(replacement, current.computerCredential)).status).toBe(204);
});
