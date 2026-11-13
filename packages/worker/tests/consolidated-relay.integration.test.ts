import { MortyClient, MortyPageRequest, WsTransport } from "@morty-build/client";
import {
    type ComputerMetadataResource,
    computerMetadataRequestCodec,
    computerMetadataResultCodec,
} from "@morty-build/client/protocol";
import { prepareTestMortyRelayBindings } from "@morty-build/relay-test-support/cloudflare";
import * as v from "valibot";
import { afterEach, beforeAll, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { connectControlledAgentRuntime, createMortyFakeDaemon } from "../../../tests/support/fake-daemon/runtime.ts";
import { mortyReply } from "../../../tests/support/fake-daemon/scenarios.ts";
import { memoryComputerCredentials } from "../../cli/tests/support/computer-credentials.ts";
import { WorkerApiTransport } from "../../web/src/services/api/worker-api-transport.ts";
import { BotChatApi } from "../../web/src/services/chat/bot-chat-api.ts";
import { connectComputerApiWebSocket } from "./support/computer-api-websocket.ts";

let createBindings: Awaited<ReturnType<typeof prepareTestMortyRelayBindings>>;
beforeAll(async () => {
    createBindings = await prepareTestMortyRelayBindings();
});
beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T00:00:00Z") }));
afterEach(() => vi.useRealTimers());

test("Given canonical Computer paths, When an owner manages identity and pairing over HTTP and WebSocket, Then both transports enforce the same access and operation identity", async () => {
    await using bindings = await createBindings();
    await bindings.configure({ APP_ORIGIN: bindings.origin });
    const signal = AbortSignal.timeout(45_000);
    const created = await bindings.request(
        new Request(`${bindings.origin}/morty/api/v1/computers`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                creationKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
            }),
            signal,
        }),
    );
    expect(created.status).toBe(201);
    const owner = v.parse(v.object({ computerId: v.string(), computerToken: v.string() }), await created.json());
    const request = (path: string, body?: object) =>
        new Request(`${bindings.origin}/morty/api/v1/computers/${owner.computerId}${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: { authorization: `Bearer ${owner.computerToken}`, "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal,
        });
    const http = await bindings.request(request("/session"));
    expect(http.status).toBe(200);
    expect(http.headers.get("Morty-Credential-Revocation")).toBe("/identity/local-credential");
    const transport = await connectComputerApiWebSocket(bindings.origin, owner.computerId, signal);
    try {
        const computer = await transport.fetch(request(""));
        expect(computer.status).toBe(200);
        expect(await computer.json()).toEqual({ computer: { computerId: owner.computerId } });
        const session = await transport.fetch(request("/session"));
        expect(session.status).toBe(200);
        expect(await session.json()).toEqual(await http.json());
        const link = await bindings.request(request("/identity/link", { computerId: owner.computerId }));
        expect(link.status).toBe(200);
        expect(await link.json()).toEqual({ computerId: owner.computerId });
        const pairing = await bindings.request(request("/pairing", { idempotencyKey: "websocket-management" }));
        expect(pairing.status).toBe(201);
        expect(await pairing.json()).toMatchObject({ pairingCode: expect.any(String) });
        const devices = await transport.fetch(request("/identity/devices"));
        expect(devices.status).toBe(404);
        const sharing = { operationId: crypto.randomUUID() };
        const shared = await transport.fetch(request("/identity/transfers", sharing));
        expect(shared.status).toBe(201);
        const transfer: unknown = await shared.json();
        const repeated = await transport.fetch(request("/identity/transfers", sharing));
        expect(repeated.status).toBe(201);
        expect(await repeated.json()).toEqual(transfer);
        const repeatedHttp = await bindings.request(request("/identity/transfers", sharing));
        expect(repeatedHttp.status).toBe(201);
        expect(await repeatedHttp.json()).toEqual(transfer);

        const unauthenticated = await transport.fetch(new Request(request("/session"), { headers: {} }));
        expect(unauthenticated.status).toBe(401);
        expect(await unauthenticated.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
        const wrongComputer = await transport.fetch(
            new Request(`${bindings.origin}/morty/api/v1/computers/prj_ap_01_abcdefghijklmnopqrstuvwx/session`, {
                signal,
            }),
        );
        expect(wrongComputer.status).toBe(400);
        expect(await wrongComputer.json()).toMatchObject({ error: { code: "invalid_target" } });
        const setup = await transport.fetch(
            new Request(`${bindings.origin}/morty/api/v1/computers/${owner.computerId}/setup`, {
                method: "POST",
                signal,
            }),
        );
        expect(setup.status).toBe(400);
        expect(await setup.json()).toMatchObject({ error: { code: "invalid_target" } });
        for (const path of ["/catalog", "/pairing/redeem"]) {
            const runtimeOnly = await transport.fetch(request(path, {}));
            expect(runtimeOnly.status).toBe(400);
            expect(await runtimeOnly.json()).toMatchObject({ error: { code: "invalid_target" } });
        }
        const oversized = { ...sharing, replaces: "x".repeat(3 * 1_024 * 1_024) };
        const oversizedHttp = await bindings.request(request("/identity/transfers", oversized));
        const oversizedWebSocket = await transport.fetch(request("/identity/transfers", oversized));
        expect(oversizedHttp.ok).toBe(false);
        expect(oversizedWebSocket.status).toBe(oversizedHttp.status);
        expect(await oversizedWebSocket.json()).toEqual(await oversizedHttp.json());
        const retired = await transport.fetch(new Request(request("/identity/local-credential"), { method: "DELETE" }));
        expect(retired.status).toBe(204);
        expect(await retired.text()).toBe("");
        expect((await transport.fetch(request("/session"))).status).toBe(401);
    } finally {
        transport.close();
    }
});

test.each(["http", "websocket"] as const)(
    "Given %s Computer APIs and the default SDK transport, When a client pairs, operates a Session and downloads a file, Then commands use WS and downloads use HTTP",
    async (apiTransport) => {
        await using bindings = await createBindings();
        await bindings.configure({ APP_ORIGIN: bindings.origin });
        const signal = AbortSignal.timeout(45_000);
        const operation = (path: string, token?: string, body?: object) =>
            new Request(`${bindings.origin}/morty/api${path}`, {
                method: body === undefined ? "GET" : "POST",
                signal,
                headers: {
                    "content-type": "application/json",
                    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        const created = await bindings.request(
            operation("/v1/computers", undefined, {
                creationKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
            }),
        );
        expect(created.status).toBe(201);
        expect(created.headers.has("server-timing")).toBe(false);
        const owner = v.parse(
            v.pipe(
                v.object({ computerToken: v.string(), computerId: v.string() }),
                v.transform(({ computerId, computerToken }) => ({ computerId, token: computerToken })),
            ),
            await created.json(),
        );
        const websocket =
            apiTransport === "websocket"
                ? await connectComputerApiWebSocket(bindings.origin, owner.computerId, signal)
                : null;
        onTestFinished(() => websocket?.close());
        const request = (path: string, token?: string, body?: object) => {
            const input = operation(path, token, body);
            return websocket !== null &&
                !path.endsWith("/setup") &&
                path.startsWith("/v1/computers/") &&
                !path.includes("/harnesses/") &&
                !path.endsWith("/pairing/redeem")
                ? websocket.fetch(input)
                : bindings.request(input);
        };
        const paired = await request(`/v1/computers/${owner.computerId}/pairing`, owner.token, {
            idempotencyKey: "single-worker",
        });
        expect(paired.status).toBe(201);
        const pairing = v.parse(v.object({ pairingCode: v.string(), relayUrl: v.string() }), await paired.json());
        expect(pairing.relayUrl).toBe(bindings.origin);
        const behavior = {
            harness: "codex",
            agentName: "Controlled Codex",
            reply: mortyReply,
            files: new Map([["/workspace/entrypoint.txt", { content: "HTTP download", mediaType: "text/plain" }]]),
        };
        const harness = createMortyFakeDaemon(behavior);
        const redeemed = await request(`/v1/computers/${owner.computerId}/pairing/redeem`, undefined, {
            pairingCode: pairing.pairingCode,
            computerName: "Single Worker",
            workspaceName: "Controlled workspace",
            agents: harness.catalog,
        });
        expect(redeemed.status).toBe(200);
        const claim = v.parse(v.object({ computerCredential: v.string() }), await redeemed.json());
        await using _runtime = await connectControlledAgentRuntime({
            behavior,
            signal,
            connection: {
                computerId: owner.computerId,
                origin: bindings.origin,
                credentials: memoryComputerCredentials(claim.computerCredential),
            },
        });
        const chat = `/v1/computers/${owner.computerId}`;
        const encryptionAccess = await _runtime.encryptionAccess(signal);
        const ownerTransport = new WorkerApiTransport(bindings.origin, () => encryptionAccess);
        const metadataWire: string[] = [];
        const observed: { readonly method: string; readonly path: string; readonly status: number }[] = [];
        const ownerClient = new BotChatApi({
            origin: bindings.origin,
            computerId: owner.computerId,
            getToken: async () => owner.token,
            encryptionAccess: () => encryptionAccess,
            sessionTransport: () => ownerTransport.computerTransport(owner.computerId),
            waitForChange: ownerTransport.waitForChange,
            fetchRequest: async (call) => {
                const input = new Request(call.endpoint.url, {
                    method: call.endpoint.method,
                    headers: call.headers,
                    body: call.body ?? null,
                    signal: call.signal,
                });
                const response =
                    apiTransport === "websocket" && !input.url.endsWith("/setup")
                        ? await websocket?.fetch(input)
                        : await bindings.request(input);
                if (response === undefined) {
                    throw new Error("Expected the Computer WebSocket transport");
                }
                if (input.url.endsWith("/workspace")) {
                    metadataWire.push(await response.clone().text());
                }
                observed.push({ method: input.method, path: new URL(input.url).pathname, status: response.status });
                return response;
            },
        });
        onTestFinished(() => {
            ownerClient.close();
            ownerTransport.dispose();
        });
        await ownerClient.verifyAgent("codex", signal);
        expect(observed).toContainEqual({ method: "POST", path: `/morty/api${chat}/setup`, status: 202 });
        const workspace = await request(`${chat}/workspace`, owner.token, {});
        expect(workspace.status).toBe(400);
        expect(await ownerClient.computerConfiguration(signal)).toEqual({
            computer: expect.objectContaining({
                computerId: owner.computerId,
                computerName: "Single Worker",
                online: true,
            }),
        });
        expect(metadataWire).toHaveLength(1);
        expect(JSON.parse(metadataWire[0] ?? "")).toEqual({
            kind: "computer.metadata.result",
            requestId: expect.any(String),
            encrypted: expect.any(String),
        });
        expect(metadataWire[0]).not.toContain("Single Worker");
        const readMetadata = async (resource: ComputerMetadataResource, path: string) => {
            const requestId = crypto.randomUUID();
            const encryption = ownerTransport.computerTransport(owner.computerId).payloadEncryption;
            const command: object = JSON.parse(
                await computerMetadataRequestCodec.encode(
                    { kind: "computer.metadata.read", requestId, resource, credential: owner.token },
                    encryption,
                    signal,
                ),
            );
            const response = await request(`${chat}/${path}`, owner.token, command);
            expect(response.status).toBe(200);
            const encoded = await response.text();
            expect(JSON.parse(encoded)).toEqual({
                kind: "computer.metadata.result",
                requestId,
                encrypted: expect.any(String),
            });
            const reply = await computerMetadataResultCodec.decode(encoded, encryption, signal);
            expect(reply.requestId).toBe(requestId);
            expect(reply.result.resource).toBe(resource);
            return { result: reply.result, encoded };
        };
        const computers = await readMetadata("computers", "setup/computers");
        expect(computers.result).toEqual({
            resource: "computers",
            computers: [expect.objectContaining({ computerId: owner.computerId, online: true })],
        });
        expect(computers.encoded).not.toContain("Single Worker");
        const shared = await request(`${chat}/identity/transfers`, owner.token, { operationId: crypto.randomUUID() });
        expect(shared.status).toBe(201);
        const sharedUrl = new URL(v.parse(v.object({ url: v.string() }), await shared.json()).url);
        const added = await bindings.request(
            operation("/v1/identity/transfers/redeem", undefined, {
                code: new URLSearchParams(sharedUrl.hash.slice(1)).get("code"),
                device: "Private phone · Safari",
            }),
        );
        expect(added.status).toBe(200);
        const devices = await readMetadata("devices", "identity/devices");
        expect(devices.result).toMatchObject({
            resource: "devices",
            devices: [{ label: "Private phone · Safari", addedBy: { kind: "computer" } }],
        });
        expect(devices.encoded).not.toContain("Private phone");
        expect((await request(`${chat}/identity/devices`, owner.token)).status).toBe(404);
        const snapshotWithoutComputerCredential = await request(`${chat}/metadata/snapshot`, owner.token, {
            resource: "computer",
        });
        expect(snapshotWithoutComputerCredential.status).toBe(401);
        const computer = await request(`/v1/computers/${owner.computerId}/pairing-state`, owner.token);
        expect(computer.status).toBe(200);
        expect(await computer.json()).toEqual({ computerPairing: "paired" });
        const access = await ownerClient.createConversation(
            "single-worker-session",
            { harness: "codex", workspaceRef: ".", workspaceLabel: ".", configurations: [] },
            signal,
        );
        expect(observed).toContainEqual({
            method: "POST",
            path: `/morty/api${chat}/managed-sessions/open`,
            status: 200,
        });
        const session = `/v1/computers/${owner.computerId}/harnesses/${access.target.harness}/sessions/${access.target.sessionId}`;
        const transport = new WsTransport();
        const responses: { readonly status: number; readonly serverTiming: string | null }[] = [];
        const client = new MortyClient({
            transport,
            encryption: { access: encryptionAccess },
            endpoint: bindings.origin,
            computerId: owner.computerId,
            credentialProvider: { credential: async () => access.credential },
            observeResponse: (response) => responses.push(response),
        });
        try {
            expect(await client.events.list(access.target, new MortyPageRequest(1, ""), signal)).toBeDefined();
            expect(await client.sessions.readConfiguration(access.target, signal)).toMatchObject({
                target: access.target,
            });
            expect(await client.sessions.rename(access.target, "SDK transport session", signal)).toMatchObject({
                title: "SDK transport session",
            });
            const bytes = new TextEncoder().encode("WebSocket upload");
            const contentKey = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
            const attachment = await client.sessions.uploadContent(
                access.target,
                {
                    bytes,
                    contentKey,
                    kind: "resource",
                    mediaType: "text/plain",
                    name: "upload.txt",
                    uri: "file:///upload.txt",
                },
                signal,
            );
            expect(attachment).toMatchObject({ contentKey, name: "upload.txt", byteLength: bytes.byteLength });
            const accepted = await client.turns.submit(
                access.target,
                {
                    content: "Reply through the owning DO",
                    attachments: [],
                    idempotencyKey: "entrypoint-turn",
                },
                signal,
            );
            expect(accepted).toMatchObject({ turnId: "entrypoint-turn", target: access.target });
            const live = await client.events.subscribeLive(
                access.target,
                { receive: async () => true, reconcile: async () => undefined },
                signal,
            );
            live.close();
            for (const operation of ["configuration", "active-turn", "events"]) {
                const response = await request(`${session}/${operation}`, access.credential);
                expect(response.status, operation).toBe(404);
                expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
            }
            const turns = await request(`${session}/turns`, access.credential, {});
            expect(turns.status).toBe(404);
            const downloaded = await client.sessions.readFile(access.target, "entrypoint.txt", signal);
            expect(responses.at(-1)).toEqual({ status: 200, serverTiming: null });
            expect(new TextDecoder().decode(downloaded.bytes)).toBe("HTTP download");
            expect(downloaded).toMatchObject({ name: "entrypoint.txt", mediaType: "application/octet-stream" });
            const audienceEndpoint = await bindings.request(
                new Request(`${bindings.origin}/morty/api/web/computers`, {
                    method: "POST",
                    body: JSON.stringify({
                        creationKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
                    }),
                    headers: { "content-type": "application/json" },
                    signal,
                }),
            );
            expect(audienceEndpoint.status).toBe(404);
        } finally {
            client.close();
            transport.close();
        }
    },
);
