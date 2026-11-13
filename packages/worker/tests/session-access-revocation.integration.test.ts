import { MortyClient, MortyPageRequest, sessionEndpoints, WsTransport } from "@morty-build/client";
import * as v from "valibot";
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import worker from "../src/worker/application.ts";
import { APP_ORIGIN, AUTH_TIME, createIdentityFixture } from "./support/identity-fixture.ts";

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AUTH_TIME);
});
afterEach(() => vi.useRealTimers());

test("Given a browser opening a Session, When its device is revoked before the Computer finishes creation, Then its pending open cannot grant fresh Session access", async () => {
    const cloud = await createIdentityFixture();
    const creation = Promise.withResolvers<void>();
    const continueCreation = Promise.withResolvers<void>();
    let hold = false;
    try {
        const owner = await cloud.createAnonymousUser();
        await using _runtime = await cloud.connectAgent(owner.computerId, owner.token, [
            {
                harness: "configuration-test",
                label: "Configuration Test",
                beforeSessionCreated: async () => {
                    if (hold) {
                        hold = false;
                        creation.resolve();
                        await continueCreation.promise;
                    }
                },
            },
        ]);
        const env = cloud.environment();
        const request = (path: string, token: string, body?: object, method = body === undefined ? "GET" : "POST") =>
            worker.fetch(
                new Request(`${APP_ORIGIN}/morty/api/${path}`, {
                    method,
                    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                }),
                env,
            );
        const computerPath = `v1/computers/${owner.computerId}`;
        const chat = `v1/computers/${owner.computerId}`;
        expect(
            (
                await request(`${chat}/setup`, owner.token, {
                    harness: "configuration-test",
                })
            ).status,
        ).toBe(202);
        const shared = await request(`${computerPath}/identity/transfers`, owner.token, {
            operationId: crypto.randomUUID(),
        });
        const code = new URL(v.parse(v.object({ url: v.string() }), await shared.json()).url).hash.slice(6);
        const redeemed = await request("v1/identity/transfers/redeem", owner.token, {
            code,
            device: "Revoked browser",
        });
        expect(redeemed.status).toBe(200);
        const browser = v.parse(v.object({ computerToken: v.string() }), await redeemed.json()).computerToken;
        const { devices } = v.parse(
            v.object({ devices: v.array(v.object({ id: v.string(), label: v.nullable(v.string()) })) }),
            await (await request(`${computerPath}/identity/devices`, owner.token)).json(),
        );
        const device = devices.find((entry) => entry.label === "Revoked browser");
        if (device === undefined) {
            throw new Error("Missing revoked browser");
        }
        hold = true;
        const opening = request(`${chat}/managed-sessions/open`, browser, {
            harness: "configuration-test",
            configurations: [],
            conversationKey: "revocation-race",
            workspaceRef: ".",
        });
        await creation.promise;
        const revoked = await request(
            `${computerPath}/identity/devices/${device.id}`,
            owner.token,
            undefined,
            "DELETE",
        );
        expect(revoked.status).toBe(200);
        expect(await revoked.json()).toEqual({ status: "device_access_ended" });
        expect((await request(`${computerPath}/session`, browser)).status).toBe(401);
        continueCreation.resolve();
        const opened = await opening;
        expect(opened.status).toBe(401);
        expect(await opened.json()).toEqual({
            error: { code: "UNAUTHENTICATED", message: "Access to this computer has ended.", reason: "ACCESS_REVOKED" },
        });
    } finally {
        continueCreation.resolve();
        await cloud.close();
    }
}, 45_000);

test("Given a device with an open Session, When its owner disconnects it while the Computer is offline, Then device and Session access are revoked together without a retry", async () => {
    const cloud = await createIdentityFixture();
    try {
        const owner = await cloud.createAnonymousUser();
        await using runtime = await cloud.connectAgent(owner.computerId, owner.token);
        const request = (path: string, token: string, body?: object, method = body === undefined ? "GET" : "POST") =>
            worker.fetch(
                new Request(`${APP_ORIGIN}/morty/api/${path}`, {
                    method,
                    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                }),
                cloud.environment(),
            );
        const computerPath = `v1/computers/${owner.computerId}`;
        const chat = `v1/computers/${owner.computerId}`;
        expect((await request(`${chat}/setup`, owner.token, { harness: "codex" })).status).toBe(202);
        const shared = await request(`${computerPath}/identity/transfers`, owner.token, {
            operationId: crypto.randomUUID(),
        });
        const code = new URL(v.parse(v.object({ url: v.string() }), await shared.json()).url).hash.slice(6);
        const redeemed = await request("v1/identity/transfers/redeem", owner.token, { code, device: "Ended browser" });
        const browser = v.parse(v.object({ computerToken: v.string() }), await redeemed.json()).computerToken;
        const { devices } = v.parse(
            v.object({ devices: v.array(v.object({ id: v.string() })) }),
            await (await request(`${computerPath}/identity/devices`, owner.token)).json(),
        );
        const device = devices[0];
        if (device === undefined) {
            throw new Error("Missing joined browser");
        }
        const opened = await request(`${chat}/managed-sessions/open`, browser, {
            harness: "codex",
            configurations: [],
            conversationKey: "ended-device-window",
            workspaceRef: ".",
        });
        expect(opened.status).toBe(200);
        const window = v.parse(
            v.object({
                computerId: v.string(),
                target: v.object({ harness: v.string(), sessionId: v.string() }),
                credential: v.string(),
            }),
            await opened.json(),
        );
        const transport = new WsTransport();
        onTestFinished(() => transport.close());
        const readAccess = () =>
            transport.fetch({
                endpoint: sessionEndpoints.readConfiguration({ computerId: window.computerId, target: window.target }),
                origin: new URL("/morty/api/", cloud.origin),
                headers: { authorization: `Bearer ${window.credential}` },
                body: null,
                signal: AbortSignal.timeout(15_000),
            });
        expect((await readAccess()).status).toBe(200);
        await runtime.disconnect();
        const failed = await request(`${computerPath}/identity/devices/${device.id}`, owner.token, undefined, "DELETE");

        expect.soft(failed.status).toBe(200);
        expect.soft(await failed.json()).toEqual({ status: "device_access_ended" });
        expect((await request(`${computerPath}/session`, browser)).status).toBe(401);

        await runtime.reconnect();
        const remaining = await request(`${computerPath}/identity/devices`, owner.token);
        expect(await remaining.json()).toMatchObject({ devices: [] });
        const denied = await readAccess();
        expect(denied.status).toBe(401);
        expect(await denied.json()).toMatchObject({ error: { code: "credential_revoked" } });
    } finally {
        await cloud.close();
    }
}, 60_000);

/** The owner's computer with a connected Computer, and the requests a browser or the owner make against it. */
async function sharedComputer(cloud: Awaited<ReturnType<typeof createIdentityFixture>>) {
    const owner = await cloud.createAnonymousUser();
    const runtime = await cloud.connectAgent(owner.computerId, owner.token);
    const request = (path: string, token: string, body?: object, method = body === undefined ? "GET" : "POST") =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/${path}`, {
                method,
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
            cloud.environment(),
        );
    const computerPath = `v1/computers/${owner.computerId}`;
    const chat = `v1/computers/${owner.computerId}`;
    expect((await request(`${chat}/setup`, owner.token, { harness: "codex" })).status).toBe(202);
    /** A browser joins through a link the owner shares, and opens a conversation it then reads. */
    const joinBrowser = async (label: string) => {
        const shared = await request(`${computerPath}/identity/transfers`, owner.token, {
            operationId: crypto.randomUUID(),
        });
        const code = new URL(v.parse(v.object({ url: v.string() }), await shared.json()).url).hash.slice(6);
        const redeemed = await request("v1/identity/transfers/redeem", owner.token, { code, device: label });
        const token = v.parse(v.object({ computerToken: v.string() }), await redeemed.json()).computerToken;
        const { devices } = v.parse(
            v.object({ devices: v.array(v.object({ id: v.string(), label: v.nullable(v.string()) })) }),
            await (await request(`${computerPath}/identity/devices`, owner.token)).json(),
        );
        const device = devices.find((entry) => entry.label === label);
        if (device === undefined) {
            throw new Error(`Missing joined browser ${label}`);
        }
        const opened = await request(`${chat}/managed-sessions/open`, token, {
            harness: "codex",
            configurations: [],
            conversationKey: `${label.toLowerCase().replaceAll(" ", "-")}-window`,
            workspaceRef: ".",
        });
        expect(opened.status).toBe(200);
        const window = v.parse(
            v.object({
                computerId: v.string(),
                target: v.object({ harness: v.string(), sessionId: v.string() }),
                credential: v.string(),
            }),
            await opened.json(),
        );
        const transport = new WsTransport();
        onTestFinished(transport.close);
        const client = new MortyClient({
            transport,
            endpoint: cloud.origin,
            computerId: window.computerId,
            credentialProvider: { credential: async () => window.credential },
        });
        onTestFinished(() => client.close());
        const readConversation = () =>
            client.events.list(window.target, new MortyPageRequest(1, ""), AbortSignal.timeout(15_000));
        await readConversation();
        /** Opens a live view of the conversation; its `completed` settles only once the view ends. */
        const watchConversation = () =>
            client.events.subscribeLive(
                window.target,
                { receive: async () => true, reconcile: async () => undefined },
                AbortSignal.timeout(30_000),
            );
        return { deviceId: device.id, token, readConversation, watchConversation };
    };
    return { owner, runtime, request, computerPath, joinBrowser };
}

test("Given two browsers reading their conversations, one watching it live, When the owner removes that one, Then its live view ends and it stops reading while the other keeps reading with the access it holds", async () => {
    const cloud = await createIdentityFixture();
    try {
        const { owner, runtime, request, computerPath, joinBrowser } = await sharedComputer(cloud);
        await using _runtime = runtime;
        const removed = await joinBrowser("Removed browser");
        const kept = await joinBrowser("Kept browser");
        const removedView = await removed.watchConversation();

        const ended = await request(
            `${computerPath}/identity/devices/${removed.deviceId}`,
            owner.token,
            undefined,
            "DELETE",
        );

        expect(await ended.json()).toEqual({ status: "device_access_ended" });
        await expect(removedView.completed).rejects.toThrow();
        await expect(removed.readConversation()).rejects.toMatchObject({ code: "credential_revoked" });
        await expect(kept.readConversation()).resolves.toBeDefined();
    } finally {
        await cloud.close();
    }
}, 60_000);

test("Given a browser reading its conversation, When it ends its own access, Then the access it already holds no longer reads the conversation", async () => {
    const cloud = await createIdentityFixture();
    try {
        const { runtime, request, computerPath, joinBrowser } = await sharedComputer(cloud);
        await using _runtime = runtime;
        const browser = await joinBrowser("Leaving browser");

        const ended = await request(`${computerPath}/identity/browser-access`, browser.token, undefined, "DELETE");

        expect(ended.status).toBe(204);
        await expect(browser.readConversation()).rejects.toMatchObject({ code: "credential_revoked" });
    } finally {
        await cloud.close();
    }
}, 60_000);
