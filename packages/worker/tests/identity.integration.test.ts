import * as v from "valibot";
import { afterAll, beforeAll, expect, test } from "vitest";
import { computerObjectName } from "../src/contracts/computer-id.ts";
import worker, { fetchPublicApplication } from "../src/worker/application.ts";
import { APP_ORIGIN, accountRequest, anonymousCreationKey, createIdentityFixture } from "./support/identity-fixture.ts";

function sharingRequest(): RequestInit {
    return {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId: crypto.randomUUID() }),
    };
}

let fixture: Awaited<ReturnType<typeof createIdentityFixture>>;

beforeAll(async () => {
    fixture = await createIdentityFixture();
});

afterAll(async () => {
    await fixture.close();
});

/** Declares its length as HTTP clients do, so the request keeps Cloudflare's location metadata. */
function creationRequest(headers: Readonly<Record<string, string>> = {}): Request {
    const body = JSON.stringify({ creationKey: anonymousCreationKey() });
    return new Request(`${APP_ORIGIN}/morty/api/computers`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", "content-length": String(body.length) },
        body,
    });
}

test("Given no D1 binding, When a user creates Computers and later links saved Computer credentials after a Worker restart, Then each creation is new and the saved credentials still open their Computer", async () => {
    let environment = fixture.environment();
    const creationKey = anonymousCreationKey();
    class RegionalRequest extends Request {
        override readonly cf: { readonly continent: string; readonly country: string };
        constructor(request: Request, continent: string, country: string) {
            super(request);
            this.cf = { continent, country };
        }
    }
    const create = async (continent: string, country: string) => {
        const body = JSON.stringify({ creationKey });
        const response = await worker.fetch(
            new RegionalRequest(
                new Request(`${APP_ORIGIN}/morty/api/computers`, {
                    method: "POST",
                    headers: { "content-type": "application/json", "content-length": String(body.length) },
                    body,
                }),
                continent,
                country,
            ),
            environment,
        );
        expect(response.status).toBe(201);
        return v.parse(
            v.object({
                computerToken: v.string(),
                computerId: v.string(),
            }),
            await response.json(),
        );
    };

    const [first, second, third] = await Promise.all([create("AS", "CN"), create("NA", "US"), create("AS", "SG")]);
    expect(new Set([first.computerId, second.computerId, third.computerId]).size).toBe(3);
    expect(first.computerId).toMatch(/^prj_an_01_/u);
    expect(second.computerId).toMatch(/^prj_wn_01_/u);
    expect(third.computerId).toMatch(/^prj_as_01_/u);
    await fixture.reload();
    environment = fixture.environment();
    for (const identity of [first, second, third]) {
        const link = () =>
            worker.fetch(
                new Request(`${APP_ORIGIN}/morty/api/computers/${identity.computerId}/identity/link`, {
                    method: "POST",
                    headers: { authorization: `Bearer ${identity.computerToken}`, "content-type": "application/json" },
                    body: JSON.stringify({ computerId: identity.computerId }),
                }),
                environment,
            );
        for (const response of [await link(), await link()]) {
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ computerId: identity.computerId });
        }
        expect(
            (await worker.fetch(accountRequest(identity.computerToken, identity.computerId), environment)).status,
        ).toBe(200);
    }
    const wrongComputerCredential = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/computers/${first.computerId}/identity/link`, {
            method: "POST",
            headers: { authorization: `Bearer ${second.computerToken}`, "content-type": "application/json" },
            body: JSON.stringify({ computerId: first.computerId }),
        }),
        environment,
    );
    expect(wrongComputerCredential.status).toBe(401);
    const namespace = environment.COMPUTER_RELAY;
    const stored = await namespace
        .get(namespace.idFromName(computerObjectName(first.computerId)))
        .fetch(new Request("https://computer.internal/stored-state"));
    expect(await stored.json()).toMatchObject({ keys: expect.arrayContaining(["computer-account", "computer-id"]) });
});

test("Given saved Computer credentials, When linking omits proof or supplies another Computer, Then access is denied without changing the valid credentials", async () => {
    const owner = await fixture.createAnonymousUser();
    const other = await fixture.createAnonymousUser();
    const link = (computerId: string, token?: string) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}/identity/link`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
                },
                body: JSON.stringify({ computerId }),
            }),
            fixture.environment(),
        );
    expect((await link(owner.computerId)).status).toBe(401);
    expect((await link(owner.computerId, other.token)).status).toBe(401);
    expect((await link(other.computerId, owner.token)).status).toBe(403);
    expect((await link(owner.computerId, owner.token)).status).toBe(200);
    const revoke = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}/identity/v1/local-credential`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${owner.token}` },
        }),
        fixture.environment(),
    );
    expect(revoke.status).toBe(204);
    const revoked = await link(owner.computerId, owner.token);
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toMatchObject({ error: { code: "UNAUTHENTICATED", reason: "ACCESS_REVOKED" } });
});

test("Given the computer creation API, When a client calls the retired anonymous-user endpoint, Then it is not found", async () => {
    const response = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/identity/anonymous-users`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ creationKey: anonymousCreationKey() }),
        }),
        fixture.environment(),
    );
    expect(response.status).toBe(404);
});

test("Given a computer account, When a caller changes only its placement prefix, Then the alias is not found and the original identity remains usable", async () => {
    const owner = await fixture.createAnonymousUser();
    const alias = `${owner.computerId.startsWith("prj_wn_") ? "prj_ap_01_" : "prj_wn_01_"}${owner.computerId.slice(10)}`;
    const response = await worker.fetch(accountRequest(owner.token, alias), fixture.environment());
    expect(response.status).toBe(404);
    expect((await worker.fetch(accountRequest(owner.token, owner.computerId), fixture.environment())).status).toBe(200);
});

test("Given a device that opened a link and opens the next one, When the reply is lost and the browser repeats the redemption with the same key, Then it gets the same access back and stays one device", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const request = (path: string, token: string, init: RequestInit = {}) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}${path}`, {
                ...init,
                headers: { authorization: `Bearer ${token}`, ...init.headers },
            }),
            environment,
        );
    const share = async () => {
        const shared = await request("/identity/transfers", owner.token, sharingRequest());
        return new URL(v.parse(v.object({ url: v.string() }), await shared.json()).url).hash.slice(6);
    };
    const redeem = async (code: string, redemptionKey: string, replaces?: string) =>
        await worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code, redemptionKey, ...(replaces === undefined ? {} : { replaces }) }),
            }),
            environment,
        );
    const token = async (response: Response) => {
        expect(response.status).toBe(200);
        return v.parse(v.object({ computerToken: v.string() }), await response.json()).computerToken;
    };
    const held = await token(await redeem(await share(), anonymousCreationKey()));

    const next = await share();
    const redemptionKey = anonymousCreationKey();
    const lost = await token(await redeem(next, redemptionKey, held));
    const repeated = await token(await redeem(next, redemptionKey, held));

    expect(repeated).toBe(lost);
    expect((await request("/session", repeated)).status).toBe(200);
    expect((await request("/session", held)).status).toBe(401);
    const listed = await request("/identity/devices", owner.token);
    expect(v.parse(v.object({ devices: v.array(v.unknown()) }), await listed.json()).devices).toHaveLength(1);
    // The link still adds one device: another browser's redemption is refused.
    expect((await redeem(next, anonymousCreationKey())).status).toBe(410);
});

test("Given a device that shared links before and after renewing its credential, When the owner removes it, Then its unused links cannot restore access while other devices and fresh invitations still work", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const request = (path: string, token: string, method = "GET", body?: object) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}${path}`, {
                method,
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
            environment,
        );
    const share = async (token: string) => {
        const response = await request("/identity/transfers", token, "POST", { operationId: crypto.randomUUID() });
        expect(response.status).toBe(201);
        return new URL(v.parse(v.object({ url: v.string() }), await response.json()).url).hash.slice(6);
    };
    const redeem = (code: string, redemptionKey = anonymousCreationKey(), replaces?: string) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code, redemptionKey, ...(replaces === undefined ? {} : { replaces }) }),
            }),
            environment,
        );
    const tokenOf = async (response: Response) => {
        expect(response.status).toBe(200);
        return v.parse(v.object({ computerToken: v.string() }), await response.json()).computerToken;
    };
    const original = await tokenOf(await redeem(await share(owner.token)));
    const listed = v.parse(
        v.object({ devices: v.array(v.object({ id: v.string() })) }),
        await (await request("/identity/devices", owner.token)).json(),
    );
    const device = listed.devices[0];
    if (device === undefined) {
        throw new Error("Missing joined device");
    }
    const unusedBeforeRenewal = await share(original);
    const openedAfterRenewal = await share(original);
    const renewed = await tokenOf(await redeem(await share(owner.token), anonymousCreationKey(), original));
    expect((await request("/session", original)).status).toBe(401);
    // Credential replacement does not end the sharing device's access or invalidate its invitations.
    const childRedemptionKey = anonymousCreationKey();
    const child = await tokenOf(await redeem(openedAfterRenewal, childRedemptionKey));
    const unusedAfterRenewal = await share(renewed);
    const independentInvitation = await share(owner.token);

    const removed = await request(`/identity/v1/devices/${device.id}`, owner.token, "DELETE");
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ status: "device_access_ended" });
    expect((await request("/session", renewed)).status).toBe(401);
    expect((await redeem(unusedBeforeRenewal)).status).toBe(410);
    expect((await redeem(unusedAfterRenewal)).status).toBe(410);
    expect((await request(`/identity/v1/devices/${device.id}`, owner.token, "DELETE")).status).toBe(200);

    // Already joined devices keep their own grants, including a retry whose first redemption reply was lost.
    expect((await request("/session", child)).status).toBe(200);
    expect(await tokenOf(await redeem(openedAfterRenewal, childRedemptionKey))).toBe(child);
    expect((await request("/session", await tokenOf(await redeem(independentInvitation)))).status).toBe(200);
    const rejoined = await tokenOf(await redeem(await share(owner.token), anonymousCreationKey(), renewed));
    expect((await request("/session", rejoined)).status).toBe(200);
    expect((await redeem(unusedBeforeRenewal)).status).toBe(410);
    expect((await redeem(unusedAfterRenewal)).status).toBe(410);
});

test("Given links shared by the computer's own credential, When that credential is revoked, Then its unused links add no device while redeemed links keep their device", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const request = (path: string, token: string, method = "GET", body?: object) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}${path}`, {
                method,
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
            environment,
        );
    const share = async (token: string) => {
        const response = await request("/identity/transfers", token, "POST", { operationId: crypto.randomUUID() });
        expect(response.status).toBe(201);
        return new URL(v.parse(v.object({ url: v.string() }), await response.json()).url).hash.slice(6);
    };
    const redeem = (code: string) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code, redemptionKey: anonymousCreationKey() }),
            }),
            environment,
        );
    const sharedByLocal = await share(owner.token);
    expect((await redeem(sharedByLocal)).status).toBe(200);

    const unusedLocalLink = await share(owner.token);
    expect((await request("/identity/v1/local-credential", owner.token, "DELETE")).status).toBe(204);
    expect((await redeem(unusedLocalLink)).status).toBe(410);
});

test("Given visitors across Cloudflare regions, When Chat provisions and reopens Morty data, Then Relay preserves every placement", {
    timeout: 30_000,
}, async () => {
    // Cloudflare supplies cf metadata on incoming Requests; Node does not.
    class GeolocatedRequest extends Request {
        override readonly cf: { readonly continent: string; readonly country: string };
        constructor(request: Request, continent: string, country: string) {
            super(request);
            this.cf = { continent, country };
        }
    }
    const environment = fixture.environment();
    for (const [continent, country, region] of [
        ["AS", "CN", "apac-ne"],
        ["AS", "SG", "apac-se"],
        ["AS", "IN", "apac"],
        ["OC", "AU", "apac"],
        ["NA", "US", "wnam"],
        ["SA", "BR", "wnam"],
        ["EU", "DE", "wnam"],
        ["AF", "ZA", "wnam"],
        ["AN", "AQ", "wnam"],
        ["unknown", "US", "apac"],
    ] as const) {
        const created = await worker.fetch(
            new GeolocatedRequest(creationRequest({ "cf-ipcountry": "US" }), continent, country),
            environment,
        );
        expect(created.status).toBe(201);
        const identity = v.parse(v.object({ computerToken: v.string(), computerId: v.string() }), await created.json());
        const computerRequest = () =>
            new Request(`${APP_ORIGIN}/morty/api/computers/${identity.computerId}/management/computer`, {
                headers: { authorization: `Bearer ${identity.computerToken}` },
            });
        const response = await worker.fetch(computerRequest(), environment);
        expect(response.status).toBe(200);
        const initial = v.parse(v.object({ computer: v.object({ computerId: v.string() }) }), await response.json());
        const regionCode = { apac: "ap", "apac-ne": "an", "apac-se": "as", wnam: "wn" }[region];
        expect(initial.computer.computerId).toMatch(new RegExp(`^prj_${regionCode}_01_`));
        const revisited = await worker.fetch(
            new GeolocatedRequest(computerRequest(), region === "wnam" ? "AS" : "NA", region === "wnam" ? "CN" : "US"),
            environment,
        );
        expect(revisited.status).toBe(200);
        expect(await revisited.json()).toMatchObject(initial);
    }
});

test("Given Computers in separate regions, When users reopen and transfer Morty access, Then Computer objects retain their identities and reject another Project", async () => {
    const environment = fixture.environment();
    class RegionalRequest extends Request {
        override readonly cf: { readonly continent: string };
        constructor(continent: string) {
            super(creationRequest());
            this.cf = { continent };
        }
    }
    const identitySchema = v.pipe(
        v.object({ computerId: v.string(), computerToken: v.string() }),
        v.transform(({ computerId, computerToken }) => ({ computerId, token: computerToken })),
    );
    const asian = await worker.fetch(new RegionalRequest("AS"), environment);
    const american = await worker.fetch(new RegionalRequest("NA"), environment);
    expect(asian.status).toBe(201);
    expect(american.status).toBe(201);
    const apac = v.parse(identitySchema, await asian.json());
    const wnam = v.parse(identitySchema, await american.json());
    const sameRegionResponse = await worker.fetch(new RegionalRequest("AS"), environment);
    expect(sameRegionResponse.status).toBe(201);
    const sameRegion = v.parse(identitySchema, await sameRegionResponse.json());
    expect((await worker.fetch(accountRequest(apac.token, sameRegion.computerId), environment)).status).toBe(401);
    expect((await worker.fetch(accountRequest(apac.token), environment)).status).toBe(401);
    for (const [identity, other] of [
        [apac, wnam],
        [wnam, apac],
    ]) {
        if (identity === undefined || other === undefined) {
            throw new Error("Missing identity fixture");
        }
        const session = await worker.fetch(accountRequest(identity.token, identity.computerId), environment);
        expect(session.status).toBe(200);
        expect(await session.json()).toMatchObject({ computerId: identity.computerId });
        expect((await worker.fetch(accountRequest(identity.token, other.computerId), environment)).status).toBe(401);
        const transfer = await worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/computers/${identity.computerId}/identity/transfers`, {
                method: "POST",
                headers: { authorization: `Bearer ${identity.token}`, "content-type": "application/json" },
                body: JSON.stringify({ operationId: crypto.randomUUID() }),
            }),
            environment,
        );
        expect(transfer.status).toBe(201);
        const { url } = v.parse(v.object({ url: v.string() }), await transfer.json());
        const code = new URLSearchParams(new URL(url).hash.slice(1)).get("code");
        const redeem = () =>
            worker.fetch(
                new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ code }),
                }),
                environment,
            );
        const redeemed = await redeem();
        expect(redeemed.status).toBe(200);
        expect(await redeemed.json()).toMatchObject({ computerId: identity.computerId });
        // A link adds one device.
        expect((await redeem()).status).toBe(410);
    }
});

test("Given a first-time visitor, When their identity and Bot are managed, Then both persist behind the Computer boundary", async () => {
    const identity = await fixture.createAnonymousUser();
    const response = await worker.fetch(accountRequest(identity.token, identity.computerId), fixture.environment());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
        computerId: identity.computerId,
        accessExpiresAt: null,
    });
    const served = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/computers/${identity.computerId}/management/computer/pairing-state`, {
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        fixture.environment(),
    );
    expect(served.status).toBe(200);
    expect(await served.json()).toEqual({ computerPairing: "unpaired" });
    const computerResponse = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/computers/${identity.computerId}/management/computer`, {
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        fixture.environment(),
    );
    const { computer } = v.parse(
        v.object({ computer: v.object({ computerId: v.string() }) }),
        await computerResponse.json(),
    );
    expect(identity.computerId).toBe(computer.computerId);
    expect(identity.token).toMatch(/^morty_computer_v1_[A-Za-z0-9_-]{43}$/u);
    // A Computer that was never created is not found, whichever credential asks for it.
    expect(
        (await worker.fetch(accountRequest(identity.token, `prj_wn_01_${"z".repeat(24)}`), fixture.environment()))
            .status,
    ).toBe(404);
});

test("Given a user with a draft Bot on a Computer-scoped Relay, When setup lists Computers, Then the available Computer options are returned", async () => {
    const environment = fixture.environment();
    const identity = await fixture.createAnonymousUser();
    const served = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/computers/${identity.computerId}/management/computer/pairing-state`, {
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        environment,
    );
    expect(served.status).toBe(200);
    const response = await fetchPublicApplication(
        new Request(`${APP_ORIGIN}/morty/api/chat/computers/${identity.computerId}/setup/computers`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${identity.token}`,
                "content-type": "application/json",
            },
            body: "{}",
        }),
        environment,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ computers: [] });
});

test("Given an anonymous user, When computer access is shared, Then the link adds one device within ten minutes and that device keeps access for a day until it ends it", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const created = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}/identity/transfers`, {
            method: "POST",
            headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
            body: JSON.stringify({ operationId: crypto.randomUUID() }),
        }),
        environment,
    );
    expect(created.status).toBe(201);
    const transfer = v.parse(
        v.object({
            url: v.string(),
            expiresAt: v.pipe(v.string(), v.isoTimestamp()),
            accessExpiresAt: v.pipe(v.string(), v.isoTimestamp()),
        }),
        await created.json(),
    );
    // Both terms start when the link is created: ten minutes to open it, a day of access for the device it adds.
    expect(Date.parse(transfer.accessExpiresAt) - Date.parse(transfer.expiresAt)).toBe(
        24 * 60 * 60 * 1000 - 10 * 60 * 1000,
    );
    const redeem = () =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code: new URL(transfer.url).hash.slice("#code=".length) }),
            }),
            environment,
        );

    const opened = await redeem();
    expect(opened.status).toBe(200);
    const device = v.parse(v.object({ computerToken: v.string() }), await opened.json()).computerToken;
    const reused = await redeem();
    expect(reused.status).toBe(410);
    expect(await reused.json()).toMatchObject({
        error: { code: "TRANSFER_UNAVAILABLE", message: "This link was already used, has expired, or was revoked." },
    });
    expect((await worker.fetch(accountRequest(device, owner.computerId), environment)).status).toBe(200);

    const ended = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}/identity/v1/browser-access`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${device}` },
        }),
        environment,
    );
    expect(ended.status).toBe(204);
    expect((await worker.fetch(accountRequest(device, owner.computerId), environment)).status).toBe(401);
    expect((await worker.fetch(accountRequest(owner.token, owner.computerId), environment)).status).toBe(200);
});

test("Given an anonymous user with a Computer, When a transfer link is redeemed, Then the redemption returns the same computer identity", async () => {
    const environment = fixture.environment();
    const identity = await fixture.createAnonymousUser();
    const servedResponse = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/computers/${identity.computerId}/management/computer/pairing-state`, {
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        environment,
    );
    expect(servedResponse.status).toBe(200);
    expect(await servedResponse.json()).not.toHaveProperty("botId");
    const transfer = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/computers/${identity.computerId}/identity/transfers`, {
            method: "POST",
            headers: { authorization: `Bearer ${identity.token}`, "content-type": "application/json" },
            body: JSON.stringify({ operationId: crypto.randomUUID() }),
        }),
        environment,
    );
    expect(transfer.status).toBe(201);
    const { url } = v.parse(v.object({ url: v.string() }), await transfer.json());
    const code = new URL(url).hash.slice("#code=".length);
    const redeemed = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code }),
        }),
        environment,
    );
    expect(redeemed.status).toBe(200);
    expect(await redeemed.json()).toMatchObject({
        computerId: identity.computerId,
    });
});

test("Given anonymous Morty sessions, When the account endpoint authenticates them, Then only valid active identities are disclosed", async () => {
    const unauthenticated = await worker.fetch(accountRequest(), {});
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    for (const token of ["morty_computer_v1_invalid", "user_alice"]) {
        expect((await worker.fetch(accountRequest(token), fixture.baseConfiguration)).status).toBe(401);
    }
    const environment = fixture.environment();
    const local = await fixture.createAnonymousUser();
    const response = await worker.fetch(accountRequest(local.token, local.computerId), environment);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
        computerId: local.computerId,
        accessExpiresAt: null,
    });
});

test("Given browser access the owner revoked, When the browser presents its credential, Then the Worker reports that its access ended instead of an unknown credential", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const transfer = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}/identity/transfers`, {
            method: "POST",
            headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
            body: JSON.stringify({ operationId: crypto.randomUUID() }),
        }),
        environment,
    );
    const code = new URL(v.parse(v.object({ url: v.string() }), await transfer.json()).url).hash.slice("#code=".length);
    const redeemed = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code }),
        }),
        environment,
    );
    const browser = v.parse(v.object({ computerToken: v.string() }), await redeemed.json()).computerToken;
    const successor = `morty_computer_v1_${"B".repeat(43)}`;
    const revoked = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}/identity/revoke-all-access`, {
            method: "POST",
            headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
            body: JSON.stringify({ successor }),
        }),
        environment,
    );
    expect(revoked.status).toBe(200);
    const management = (token: string) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}/management/computer/pairing-state`, {
                headers: { authorization: `Bearer ${token}` },
            }),
            environment,
        );
    const unknownToken = `morty_computer_v1_${"A".repeat(43)}`;

    // Released pages read the status and code, which stay as they were.
    for (const response of [
        await worker.fetch(accountRequest(browser, owner.computerId), environment),
        await management(browser),
    ]) {
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({
            error: { code: "UNAUTHENTICATED", message: "Access to this computer has ended.", reason: "ACCESS_REVOKED" },
        });
    }
    for (const response of [
        await worker.fetch(accountRequest(unknownToken, owner.computerId), environment),
        await management(unknownToken),
    ]) {
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } });
    }
    expect((await worker.fetch(accountRequest(successor, owner.computerId), environment)).status).toBe(200);
});

test("Given a browser that opened one link, When it opens another link for the same user and later ends its access, Then its earlier credential stops at once while another device keeps its own access", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const request = (path: string, token: string, init: RequestInit = {}) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}${path}`, {
                ...init,
                headers: { authorization: `Bearer ${token}`, ...init.headers },
            }),
            environment,
        );
    const share = async () => {
        const response = await request("/identity/transfers", owner.token, sharingRequest());
        expect(response.status).toBe(201);
        return new URL(v.parse(v.object({ url: v.string() }), await response.json()).url).hash.slice("#code=".length);
    };
    const redeem = (code: string, replaces?: string) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code, ...(replaces === undefined ? {} : { replaces }) }),
            }),
            environment,
        );
    const opened = async (code: string, replaces?: string) => {
        const response = await redeem(code, replaces);
        expect(response.status).toBe(200);
        return v.parse(v.object({ computerToken: v.string() }), await response.json()).computerToken;
    };
    const firstLink = await share();
    const secondLink = await share();
    const phone = await opened(await share());
    const earlier = await opened(firstLink);

    const later = await opened(secondLink, earlier);

    // The browser keeps one credential: the one it opened the later link with replaces the earlier one.
    expect((await request("/session", earlier)).status).toBe(401);
    expect((await request("/session", later)).status).toBe(200);
    expect((await request("/session", phone)).status).toBe(200);

    expect((await request("/identity/v1/browser-access", later, { method: "DELETE" })).status).toBe(204);

    // Ending this browser's access ends what it joined through; each link added one device, so others keep theirs.
    for (const code of [firstLink, secondLink]) {
        expect((await redeem(code)).status).toBe(410);
    }
    expect((await request("/session", later)).status).toBe(401);
    expect((await request("/session", phone)).status).toBe(200);
    expect((await request("/session", owner.token)).status).toBe(200);
});

test("Given a device with a month of access, When it opens a link that grants less, Then it keeps its month, in its session, the device list and what it can share", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const request = (path: string, token: string, init: RequestInit = {}) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}${path}`, {
                ...init,
                headers: { authorization: `Bearer ${token}`, ...init.headers },
            }),
            environment,
        );
    const share = async (token: string, accessDuration: string) => {
        const response = await request("/identity/transfers", token, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ operationId: crypto.randomUUID(), accessDuration }),
        });
        expect(response.status).toBe(201);
        const link = v.parse(v.object({ url: v.string(), accessExpiresAt: v.string() }), await response.json());
        return { code: new URL(link.url).hash.slice("#code=".length), accessExpiresAt: link.accessExpiresAt };
    };
    const opened = async (code: string, device: string, replaces?: string) => {
        const response = await worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code, device, ...(replaces === undefined ? {} : { replaces }) }),
            }),
            environment,
        );
        expect(response.status).toBe(200);
        return v.parse(v.object({ computerToken: v.string() }), await response.json()).computerToken;
    };
    const term = async (token: string) =>
        v.parse(v.object({ accessExpiresAt: v.string() }), await (await request("/session", token)).json())
            .accessExpiresAt;
    const listed = async () =>
        v.parse(
            v.object({
                devices: v.array(v.object({ label: v.nullable(v.string()), accessExpiresAt: v.string() })),
            }),
            await (await request("/identity/devices", owner.token)).json(),
        ).devices;

    const month = await share(owner.token, "30d");
    const phone = await opened(month.code, "iPhone · Safari");
    const guest = await opened((await share(owner.token, "1h")).code, "Guest · Chrome");
    // The guest's link is capped at the guest's own hour.
    const guestLink = await share(guest, "30d");
    expect(Date.parse(guestLink.accessExpiresAt)).toBeLessThan(Date.parse(month.accessExpiresAt));

    const reopened = await opened(guestLink.code, "iPhone · Safari", phone);

    expect((await request("/session", phone)).status).toBe(401);
    expect(await term(reopened)).toBe(month.accessExpiresAt);
    expect((await listed()).filter((device) => device.label === "iPhone · Safari")).toStrictEqual([
        { label: "iPhone · Safari", accessExpiresAt: month.accessExpiresAt },
    ]);
    expect((await share(reopened, "30d")).accessExpiresAt).toBe(month.accessExpiresAt);

    // Ending the device's access still ends it at once.
    expect((await request("/identity/v1/browser-access", reopened, { method: "DELETE" })).status).toBe(204);
    expect((await request("/session", reopened)).status).toBe(401);
});

test("Given two tabs of one browser open new links at once, When the browser later ends its access from either tab, Then every link it joined through stops opening Morty", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const request = (path: string, token: string, init: RequestInit = {}) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}${path}`, {
                ...init,
                headers: { authorization: `Bearer ${token}`, ...init.headers },
            }),
            environment,
        );
    const share = async () => {
        const response = await request("/identity/transfers", owner.token, sharingRequest());
        expect(response.status).toBe(201);
        return new URL(v.parse(v.object({ url: v.string() }), await response.json()).url).hash.slice("#code=".length);
    };
    const redeem = (code: string, replaces?: string) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code, ...(replaces === undefined ? {} : { replaces }) }),
            }),
            environment,
        );
    const token = async (response: Response) => {
        expect(response.status).toBe(200);
        return v.parse(v.object({ computerToken: v.string() }), await response.json()).computerToken;
    };
    const links = [await share(), await share(), await share()];
    const held = await token(await redeem(v.parse(v.string(), links[0])));

    // Both tabs read the same held access before either redemption finishes.
    const [first, second] = await Promise.all([
        redeem(v.parse(v.string(), links[1]), held).then(token),
        redeem(v.parse(v.string(), links[2]), held).then(token),
    ]);

    expect((await request("/session", held)).status).toBe(401);
    expect((await request("/identity/v1/browser-access", second, { method: "DELETE" })).status).toBe(204);
    for (const code of links) {
        expect((await redeem(code)).status).toBe(410);
    }
    for (const credential of [first, second]) {
        expect((await request("/session", credential)).status).toBe(401);
    }
});

test("Given browsers that joined through links shared by the computer and by another browser, When one lists the linked devices, Then each other device appears as it first joined and with who shared its link", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const request = (path: string, token: string, init: RequestInit = {}) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}${path}`, {
                ...init,
                headers: { authorization: `Bearer ${token}`, ...init.headers },
            }),
            environment,
        );
    const join = async (sharer: string, device: string, replaces?: string) => {
        const shared = await request("/identity/transfers", sharer, sharingRequest());
        const code = new URL(v.parse(v.object({ url: v.string() }), await shared.json()).url).hash.slice(6);
        const redeemed = await worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code, device, ...(replaces === undefined ? {} : { replaces }) }),
            }),
            environment,
        );
        expect(redeemed.status).toBe(200);
        return v.parse(v.object({ computerToken: v.string() }), await redeemed.json()).computerToken;
    };
    const listed = async (token: string) => {
        // Through the public entry, as browsers without the WebSocket bridge and other clients reach it.
        const response = await fetchPublicApplication(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}/identity/devices`, {
                headers: { authorization: `Bearer ${token}` },
            }),
            environment,
        );
        expect(response.status).toBe(200);
        const { devices } = v.parse(
            v.object({
                devices: v.array(
                    v.looseObject({
                        joinedAt: v.pipe(v.string(), v.isoTimestamp()),
                        id: v.string(),
                        accessExpiresAt: v.pipe(v.string(), v.isoTimestamp()),
                    }),
                ),
            }),
            await response.json(),
        );
        return devices.map(({ joinedAt: _joinedAt, id: _id, accessExpiresAt: _term, ...device }) => device);
    };

    const laptop = await join(owner.token, "Mac · Chrome");
    const phone = await join(laptop, "iPhone · Safari");
    // The same browser opening another link stays the device that first joined.
    await join(owner.token, "iPhone · Chrome", phone);

    const phoneAddedByLaptop = {
        label: "iPhone · Safari",
        location: null,
        addedBy: { kind: "device", label: "Mac · Chrome" },
    };
    expect(await listed(laptop)).toEqual([phoneAddedByLaptop]);
    expect(await listed(owner.token)).toEqual([
        { label: "Mac · Chrome", location: null, addedBy: { kind: "computer" } },
        phoneAddedByLaptop,
    ]);
});

test("Given the owner chooses how long a shared device keeps access, When the link is opened or replaced, Then the device keeps exactly that term and only the latest link works", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const request = (path: string, token: string, init: RequestInit = {}) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}${path}`, {
                ...init,
                headers: { authorization: `Bearer ${token}`, ...init.headers },
            }),
            environment,
        );
    const share = (body: object) =>
        request("/identity/transfers", owner.token, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ operationId: crypto.randomUUID(), ...body }),
        });
    const link = v.object({
        url: v.string(),
        expiresAt: v.string(),
        accessExpiresAt: v.string(),
        accessDuration: v.string(),
    });
    const codeOf = (url: string) => new URL(url).hash.slice("#code=".length);
    const redeem = (code: string) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code }),
            }),
            environment,
        );

    expect((await share({ accessDuration: "1y" })).status).toBe(400);
    const first = v.parse(link, await (await share({})).json());
    // Without a choice the link grants the default day, and says so: callers show what the Worker applied.
    expect(first.accessDuration).toBe("1d");
    const created = await share({ accessDuration: "7d", replaces: codeOf(first.url) });
    expect(created.status).toBe(201);
    const week = v.parse(link, await created.json());
    expect(week.accessDuration).toBe("7d");
    // The device term runs from the link's creation, a week past the ten minutes the link itself stays open.
    expect(Date.parse(week.accessExpiresAt) - Date.parse(week.expiresAt)).toBe(
        7 * 24 * 60 * 60 * 1000 - 10 * 60 * 1000,
    );

    expect((await redeem(codeOf(first.url))).status).toBe(410);
    const opened = await redeem(codeOf(week.url));
    expect(opened.status).toBe(200);
    const device = v.parse(v.object({ computerToken: v.string() }), await opened.json()).computerToken;
    const session = v.parse(
        v.object({ accessExpiresAt: v.string() }),
        await (await request("/session", device)).json(),
    );
    expect(session.accessExpiresAt).toBe(week.accessExpiresAt);
});

test("Given a committed sharing replacement whose reply was lost, When it is retried and two edits compete, Then the original result is recovered and only one successor grants access", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const share = (body: object) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}/identity/transfers`, {
                method: "POST",
                headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
                body: JSON.stringify({ operationId: crypto.randomUUID(), ...body }),
            }),
            environment,
        );
    const link = v.object({ url: v.string(), accessExpiresAt: v.string(), expiresAt: v.string() });
    const codeOf = (url: string) => new URL(url).hash.slice("#code=".length);
    const redeem = (code: string) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code }),
            }),
            environment,
        );
    const original = v.parse(link, await (await share({ operationId: crypto.randomUUID() })).json());
    const replacement = {
        operationId: crypto.randomUUID(),
        accessDuration: "7d",
        replaces: codeOf(original.url),
    };
    const committed = v.parse(link, await (await share(replacement)).json());
    // Repeat the exact intent after an ambiguous result, without inventing a new operation.
    const recovered = v.parse(link, await (await share(replacement)).json());
    expect.soft(recovered.url === committed.url).toBe(true);
    expect.soft(recovered.accessExpiresAt).toBe(committed.accessExpiresAt);
    expect.soft(recovered.expiresAt).toBe(committed.expiresAt);
    expect.soft((await share({ ...replacement, accessDuration: "1h" })).status).toBe(409);
    expect.soft((await share({ ...replacement, operationId: crypto.randomUUID() })).status).toBe(409);

    const competing = await Promise.all(
        ["1h", "1d"].map((accessDuration) =>
            share({ operationId: crypto.randomUUID(), accessDuration, replaces: codeOf(recovered.url) }),
        ),
    );
    expect.soft(competing.map((response) => response.status).sort()).toEqual([201, 409]);
    const accepted = competing.find((response) => response.status === 201);
    if (accepted === undefined) {
        throw new Error("No sharing replacement succeeded");
    }
    const current = v.parse(link, await accepted.json());
    expect((await redeem(codeOf(original.url))).status).toBe(410);
    expect((await redeem(codeOf(recovered.url))).status).toBe(410);
    const opened = await redeem(codeOf(current.url));
    expect(opened.status).toBe(200);
    const device = v.parse(v.object({ computerToken: v.string() }), await opened.json());
    const session = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}/session`, {
            headers: { authorization: `Bearer ${device.computerToken}` },
        }),
        environment,
    );
    expect(v.parse(v.object({ accessExpiresAt: v.string() }), await session.json()).accessExpiresAt).toBe(
        current.accessExpiresAt,
    );
});

test("Given two devices that joined through links, When one disconnects the other, Then only that device loses access, retrying is harmless, no device can disconnect itself and the other rejoins only as a new device", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const request = (path: string, token: string, init: RequestInit = {}) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}${path}`, {
                ...init,
                headers: { authorization: `Bearer ${token}`, ...init.headers },
            }),
            environment,
        );
    const join = async (device: string, replaces?: string) => {
        const shared = await request("/identity/transfers", owner.token, sharingRequest());
        const code = new URL(v.parse(v.object({ url: v.string() }), await shared.json()).url).hash.slice(6);
        const opened = await worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code, device, ...(replaces === undefined ? {} : { replaces }) }),
            }),
            environment,
        );
        return v.parse(v.object({ computerToken: v.string() }), await opened.json()).computerToken;
    };
    const devices = async (token: string) =>
        v.parse(
            v.object({
                devices: v.array(v.object({ id: v.string(), joinedAt: v.string(), label: v.nullable(v.string()) })),
            }),
            await (await request("/identity/devices", token)).json(),
        ).devices;
    const phone = await join("iPhone · Safari");
    const laptop = await join("macOS · Chrome");
    const laptopId = (await devices(phone)).find((device) => device.label === "macOS · Chrome")?.id ?? "";
    const phoneId = (await devices(laptop)).find((device) => device.label === "iPhone · Safari")?.id ?? "";

    const ended = await request(`/identity/v1/devices/${laptopId}`, phone, { method: "DELETE" });

    expect(ended.status).toBe(200);
    expect((await request("/session", laptop)).status).toBe(401);
    expect((await request("/session", phone)).status).toBe(200);
    expect((await request("/session", owner.token)).status).toBe(200);
    expect((await devices(phone)).map((device) => device.label)).toEqual([]);
    expect((await request(`/identity/v1/devices/${laptopId}`, phone, { method: "DELETE" })).status).toBe(200);
    expect((await request(`/identity/v1/devices/${phoneId}`, phone, { method: "DELETE" })).status).toBe(409);
    expect((await request("/session", phone)).status).toBe(200);

    // The disconnected browser opens a later link with the credential it still stores: it joins as a new device, so
    // the phone is told about it again.
    const rejoined = await join("macOS · Chrome", laptop);
    expect((await request("/session", rejoined)).status).toBe(200);
    expect(await devices(phone)).toEqual([
        { id: expect.not.stringMatching(laptopId), joinedAt: expect.any(String), label: "macOS · Chrome" },
    ]);
});

test("Given a browser whose credential a later link replaced, When a stale tab opens a link with the replaced credential and another device later ends that browser's device, Then the browser stays one device until then and rejoins only as a new one", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const request = (path: string, token: string, init: RequestInit = {}) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}${path}`, {
                ...init,
                headers: { authorization: `Bearer ${token}`, ...init.headers },
            }),
            environment,
        );
    const join = async (device: string, replaces?: string) => {
        const shared = await request("/identity/transfers", owner.token, sharingRequest());
        const code = new URL(v.parse(v.object({ url: v.string() }), await shared.json()).url).hash.slice(6);
        const opened = await worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code, device, ...(replaces === undefined ? {} : { replaces }) }),
            }),
            environment,
        );
        expect(opened.status).toBe(200);
        return v.parse(v.object({ computerToken: v.string() }), await opened.json()).computerToken;
    };
    const devices = async (token: string) =>
        v.parse(
            v.object({ devices: v.array(v.object({ id: v.string(), label: v.nullable(v.string()) })) }),
            await (await request("/identity/devices", token)).json(),
        ).devices;
    const refusedAsEnded = async (token: string) => {
        const response = await request("/session", token);
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({
            error: { code: "UNAUTHENTICATED", message: "Access to this computer has ended.", reason: "ACCESS_REVOKED" },
        });
    };
    const phone = await join("iPhone · Safari");
    const first = await join("macOS · Chrome");
    const laptopId = (await devices(phone)).find((device) => device.label === "macOS · Chrome")?.id ?? "";
    const later = await join("macOS · Chrome", first);

    // A tab that still holds the replaced credential opens another link: the device still holds access, so the
    // browser stays the same device.
    const stale = await join("macOS · Chrome", first);

    await refusedAsEnded(first);
    for (const token of [later, stale]) {
        expect((await request("/session", token)).status).toBe(200);
    }
    expect(await devices(phone)).toEqual([{ id: laptopId, label: "macOS · Chrome" }]);

    expect((await request(`/identity/v1/devices/${laptopId}`, phone, { method: "DELETE" })).status).toBe(200);

    for (const token of [first, later, stale]) {
        await refusedAsEnded(token);
    }
    expect(await devices(phone)).toEqual([]);
    const rejoined = await join("macOS · Chrome", first);
    expect((await request("/session", rejoined)).status).toBe(200);
    expect(await devices(phone)).toEqual([{ id: expect.not.stringMatching(laptopId), label: "macOS · Chrome" }]);
});

test("Given a browser that shared a link nobody opened yet, When it disconnects every other browser, Then that link adds no device while the browser keeps its own access", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const request = (path: string, token: string, init: RequestInit = {}) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}${path}`, {
                ...init,
                headers: { authorization: `Bearer ${token}`, ...init.headers },
            }),
            environment,
        );
    const share = async (token: string) => {
        const shared = await request("/identity/transfers", token, sharingRequest());
        return new URL(v.parse(v.object({ url: v.string() }), await shared.json()).url).hash.slice(6);
    };
    const open = (code: string, device: string) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code, device }),
            }),
            environment,
        );
    const phone = v.parse(
        v.object({ computerToken: v.string() }),
        await (await open(await share(owner.token), "iPhone · Safari")).json(),
    ).computerToken;
    const pending = await share(phone);

    const ended = await request("/identity/v1/other-browser-access", phone, { method: "DELETE" });

    expect(ended.status).toBe(200);
    expect((await open(pending, "macOS · Chrome")).status).toBe(410);
    expect((await request("/session", phone)).status).toBe(200);
});
