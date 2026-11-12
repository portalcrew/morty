import { fileURLToPath } from "node:url";
import * as v from "valibot";
import { afterAll, beforeAll, expect, test } from "vitest";
import { computerObjectName } from "../src/contracts/computer-id.ts";
import worker, { fetchPublicApplication } from "../src/worker/application.ts";
import { APP_ORIGIN, createIdentityFixture } from "./support/identity-fixture.ts";

let fixture: Awaited<ReturnType<typeof createIdentityFixture>>;
beforeAll(async () => {
    fixture = await createIdentityFixture({
        workerEntryPoint: fileURLToPath(new URL("./support/credential-storage-worker.ts", import.meta.url)),
    });
});
afterAll(async () => {
    await fixture.close();
});

test("Given local and browser credentials, When their operations end access, Then each preserves the other credential kind", async () => {
    const owner = await fixture.createAnonymousUser();
    const request = (path: string, token: string, method = "GET", body?: object) =>
        fetchPublicApplication(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}${path}`, {
                method,
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
            fixture.environment(),
        );
    const share = async () => {
        const response = await request("/identity/transfers", owner.token, "POST", {
            operationId: crypto.randomUUID(),
        });
        return new URL(v.parse(v.object({ url: v.string() }), await response.json()).url).hash.slice(6);
    };
    const redeem = async (code: string) =>
        await worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code }),
            }),
            fixture.environment(),
        );
    const browser = v.parse(
        v.object({ computerToken: v.string() }),
        await (await redeem(await share())).json(),
    ).computerToken;
    // Another device retains its independent browser access.
    expect((await redeem(await share())).status).toBe(200);
    const operations = [
        { token: owner.token, path: "/identity/v1/local-credential" },
        { token: browser, path: "/identity/v1/browser-access" },
    ];
    for (const operation of operations) {
        const session = await request("/session", operation.token);
        expect(session.status).toBe(200);
        expect(session.headers.get("Morty-Credential-Revocation")).toBe(operation.path);
        for (const other of operations.filter((entry) => entry.path !== operation.path)) {
            const rejected = await request(other.path, operation.token, "DELETE");
            expect(rejected.status).toBe(403);
            expect(await rejected.json()).toMatchObject({ error: { code: "CREDENTIAL_KIND_REQUIRED" } });
        }
    }
    for (const token of [browser]) {
        const refused = await fetchPublicApplication(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}/identity/revoke-all-access`, {
                method: "POST",
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                body: JSON.stringify({ successor: `morty_computer_v1_${"A".repeat(43)}` }),
            }),
            fixture.environment(),
        );
        expect(refused.status).toBe(403);
    }
    for (const [index, operation] of operations.entries()) {
        expect((await request(operation.path, operation.token, "DELETE")).status).toBe(204);
        expect((await request("/session", operation.token)).status).toBe(401);
        expect((await request(operation.path, operation.token, "DELETE")).status).toBe(401);
        for (const remaining of operations.slice(index + 1)) {
            expect((await request("/session", remaining.token)).status).toBe(200);
        }
    }
});

test("Given a browser that joined through a link, When it asks for a Computer pairing or the Computer's binding, Then only the computer's local credential may issue them", async () => {
    const owner = await fixture.createAnonymousUser();
    const request = (path: string, token: string, method = "GET", body?: object) =>
        fetchPublicApplication(
            new Request(`${APP_ORIGIN}/morty/api${path}`, {
                method,
                headers: {
                    authorization: `Bearer ${token}`,
                    ...(body === undefined ? {} : { "content-type": "application/json" }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
            fixture.environment(),
        );
    const computerPath = `/computers/${owner.computerId}`;
    const transfer = await request(`${computerPath}/identity/transfers`, owner.token, "POST", {
        operationId: crypto.randomUUID(),
    });
    const code = new URL(v.parse(v.object({ url: v.string() }), await transfer.json()).url).hash.slice(6);
    const redeemed = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code }),
        }),
        fixture.environment(),
    );
    const browser = v.parse(v.object({ computerToken: v.string() }), await redeemed.json()).computerToken;

    for (const token of [browser]) {
        for (const refused of [
            await request(`${computerPath}/management/pairing`, token, "POST", {
                idempotencyKey: "shared-pairing",
            }),
            await request(`/chat/computers/${owner.computerId}/setup`, token, "POST", {
                harness: "codex",
            }),
        ]) {
            expect(refused.status).toBe(403);
            expect(await refused.json()).toMatchObject({ error: { code: "LOCAL_IDENTITY_REQUIRED" } });
        }
    }
    // Shared access still shares onward, as the sharing dialog offers, and still ends itself.
    expect(
        (await request(`${computerPath}/identity/transfers`, browser, "POST", { operationId: crypto.randomUUID() }))
            .status,
    ).toBe(201);
    expect((await request(`${computerPath}/identity/v1/browser-access`, browser, "DELETE")).status).toBe(204);
    expect((await request(`${computerPath}/session`, browser)).status).toBe(401);
});

test("Given browser access granted through a link, When the access term its link granted passes, Then that access ends while the computer's own access stays", async () => {
    const owner = await fixture.createAnonymousUser();
    const session = (token: string) =>
        fetchPublicApplication(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}/session`, {
                headers: { authorization: `Bearer ${token}` },
            }),
            fixture.environment(),
        );
    const transfer = await fetchPublicApplication(
        new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}/identity/transfers`, {
            method: "POST",
            headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
            body: JSON.stringify({ operationId: crypto.randomUUID() }),
        }),
        fixture.environment(),
    );
    const code = new URL(v.parse(v.object({ url: v.string() }), await transfer.json()).url).hash.slice(6);
    const redeemed = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code }),
        }),
        fixture.environment(),
    );
    const browser = v.parse(v.object({ computerToken: v.string() }), await redeemed.json()).computerToken;
    expect((await session(browser)).status).toBe(200);

    const namespace = fixture.environment().COMPUTER_RELAY;
    const storage = namespace.get(namespace.idFromName(computerObjectName(owner.computerId)));
    const aged = await storage.fetch(new Request("https://computer.internal/aged-links", { method: "POST" }));
    expect(aged.status).toBe(204);

    const expired = await session(browser);
    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual({
        error: { code: "UNAUTHENTICATED", message: "Access to this computer has ended.", reason: "ACCESS_REVOKED" },
    });
    expect((await session(owner.token)).status).toBe(200);
});

test("Given browser access granted through a link, When that browser shares a new link, Then the device it adds keeps access no longer than the browser's own", async () => {
    const owner = await fixture.createAnonymousUser();
    const share = async (token: string) => {
        const response = await fetchPublicApplication(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}/identity/transfers`, {
                method: "POST",
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                body: JSON.stringify({ operationId: crypto.randomUUID() }),
            }),
            fixture.environment(),
        );
        expect(response.status).toBe(201);
        return v.parse(
            v.object({ url: v.string(), accessExpiresAt: v.pipe(v.string(), v.isoTimestamp()) }),
            await response.json(),
        );
    };
    const ownerLink = await share(owner.token);
    const redeemed = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code: new URL(ownerLink.url).hash.slice(6) }),
        }),
        fixture.environment(),
    );
    const browser = v.parse(v.object({ computerToken: v.string() }), await redeemed.json()).computerToken;

    const browserLink = await share(browser);

    expect(browserLink.accessExpiresAt).toBe(ownerLink.accessExpiresAt);
});

test("Given a well-formed Computer identifier that was never created, When an unauthenticated request reaches it, Then it is not found and its Durable Object stores nothing", async () => {
    const computerId = `prj_ap_01_${"N".repeat(24)}`;
    const response = await fetchPublicApplication(
        new Request(`${APP_ORIGIN}/morty/api/computers/${computerId}/session`),
        fixture.environment(),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "COMPUTER_NOT_FOUND" } });
    const namespace = fixture.environment().COMPUTER_RELAY;
    const stored = await namespace
        .get(namespace.idFromName(computerObjectName(computerId)))
        .fetch(new Request("https://computer.internal/stored-state"));
    expect(await stored.json()).toEqual({ keys: [], tables: [] });
});
