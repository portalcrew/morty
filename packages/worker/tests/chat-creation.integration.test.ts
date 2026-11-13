import { fileURLToPath } from "node:url";
import { MortyClient, MortyPageRequest, WsTransport } from "@morty-build/client";
import * as v from "valibot";
import { afterEach, test as baseTest, beforeEach, expect, onTestFinished, vi } from "vitest";
import type { ControlledAgent } from "../../../tests/support/fake-daemon/runtime.ts";
import worker, { fetchPublicApplication } from "../src/worker/application.ts";
import { APP_ORIGIN, AUTH_TIME, createIdentityFixture } from "./support/identity-fixture.ts";

const targetSchema = v.object({ harness: v.string(), sessionId: v.string() });

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AUTH_TIME);
});
afterEach(() => vi.useRealTimers());

const test = baseTest.extend<{ readonly cloud: Awaited<ReturnType<typeof createIdentityFixture>> }>({
    cloud: [
        // biome-ignore lint/correctness/noEmptyPattern: Vitest fixtures declare their dependencies by destructuring.
        async ({}, use) => {
            const cloud = await createIdentityFixture({
                // Requests reach the Relay through a real proxy that can lose an answer the Relay sent.
                loseTurnResponses: true,
                workerEntryPoint: fileURLToPath(new URL("./support/credential-storage-worker.ts", import.meta.url)),
            });
            try {
                await use(cloud);
            } finally {
                await cloud.close();
            }
        },
        { scope: "file" },
    ],
});

test.beforeAll(async ({ cloud }) => {
    void cloud;
}, 30_000);

async function createChatFixture(
    cloud: Awaited<ReturnType<typeof createIdentityFixture>>,
    agents: readonly ControlledAgent[] = [{ harness: "codex", label: "Codex" }],
    sessionIds: ReadonlySet<string> = new Set(),
) {
    const identity = await cloud.createAnonymousUser();
    const runtime = await cloud.connectAgent(identity.computerId, identity.token, agents, sessionIds);
    const environment = cloud.environment();
    const request = (path: string, body?: object, method = body === undefined ? "GET" : "POST") => {
        const input = new Request(
            `${APP_ORIGIN}/morty/api/v1/${path.startsWith("chat/computers/") ? path.slice(5) : path.startsWith("chat/") ? path.replace("chat/", `computers/${identity.computerId}/`) : `computers/${identity.computerId}/${path}`}`,
            {
                method,
                headers: {
                    authorization: `Bearer ${identity.token}`,
                    "content-type": "application/json",
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            },
        );
        if (cloud.network !== null) {
            const url = new URL(input.url);
            return fetch(new Request(`${cloud.network.origin}${url.pathname}${url.search}`, input));
        }
        return worker.fetch(input, environment);
    };
    return {
        computerId: identity.computerId,
        request,
        runtime,
        [Symbol.asyncDispose]: () => runtime[Symbol.asyncDispose](),
    };
}

test("Given an archived conversation, When the original creation request is retried, Then its receipt cannot restore the archived Session", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    expect((await fixture.request("chat/setup", { harness: "codex" })).status).toBe(202);
    const input = {
        harness: "codex",
        configurations: [],
        conversationKey: "archived-creation-retry",
        workspaceRef: ".",
    };
    const created = await fixture.request("chat/managed-sessions/open", input);
    expect(created.status).toBe(200);
    const { target } = v.parse(v.object({ target: targetSchema }), await created.json());
    const ordinaryRetry = await fixture.request("chat/managed-sessions/open", input);
    expect(ordinaryRetry.status).toBe(200);
    expect(v.parse(v.object({ target: targetSchema }), await ordinaryRetry.json()).target).toEqual(target);
    expect((await fixture.request("chat/managed-sessions/archive", target)).status).toBe(200);
    expect(await (await fixture.request("chat/managed-sessions", {})).json()).toEqual({ sessions: [] });
    const refusedBeforeReplay = await fixture.request("chat/managed-sessions/open", target);
    expect(refusedBeforeReplay.status).toBe(404);
    expect(await refusedBeforeReplay.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    const retried = await fixture.request("chat/managed-sessions/open", input);
    expect(retried.status).toBe(200);
    expect(v.parse(v.object({ target: targetSchema }), await retried.json()).target).toEqual(target);
    expect(await (await fixture.request("chat/managed-sessions", {})).json()).toEqual({ sessions: [] });
    expect((await fixture.request("chat/managed-sessions/open", target)).status).toBe(404);
});

test("Given a paired computer, When its owner selects and creates with harness, Then setup and session access expose the same harness", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const setup = await fixture.request("chat/setup", { harness: "codex" });
    expect(setup.status).toBe(202);
    const workspace = await fixture.request("chat/workspace", {});
    expect(await workspace.json()).toMatchObject({ computer: { agents: [{ harness: "codex" }] } });
    const created = await fixture.request("chat/managed-sessions/open", {
        harness: "codex",
        configurations: [],
        conversationKey: "unified-harness",
        workspaceRef: ".",
    });
    expect(created.status).toBe(200);
    const access = await created.json();
    expect(access).toMatchObject({ harness: "codex", target: { harness: "codex" } });
    expect(access).not.toHaveProperty("agentRef");
    expect(access).not.toHaveProperty("agentId");
    const { target } = v.parse(v.object({ target: targetSchema }), access);
    const restored = await fixture.request("chat/managed-sessions/open", target);
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ harness: "codex", target });
});

test("Given a computer addressed by its identity, When its owner requests access to a Session the Computer does not hold, Then Chat refuses to mint a credential while held Sessions remain usable", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    expect((await fixture.request(`chat/setup`, { harness: "codex" })).status).toBe(202);
    const unowned = await fixture.request(`chat/native-sessions/access`, {
        harness: "codex",
        sessionId: "chat_unowned_security_audit",
    });
    expect(unowned.status).toBe(404);
    expect(await unowned.json()).toMatchObject({ error: { code: "NOT_FOUND" } });

    const opened = await fixture.request(`chat/managed-sessions/open`, {
        harness: "codex",
        configurations: [],
        conversationKey: "security-audit-owned",
        workspaceRef: ".",
    });
    expect(opened.status).toBe(200);
    const { sessionId } = v.parse(v.object({ target: targetSchema }), await opened.json()).target;
    const access = await fixture.request(`chat/native-sessions/access`, {
        harness: "codex",
        sessionId: sessionId,
    });
    expect(access.status).toBe(200);
    expect(await access.json()).toMatchObject({
        target: { harness: "codex", sessionId: sessionId },
        credential: expect.stringMatching(/^msession_/u),
    });

    // Another computer identity opens nothing with this credential, even for a Session the caller owns.
    const anotherComputer = await cloud.createAnonymousUser();
    const otherComputer = await fixture.request(`chat/computers/${anotherComputer.computerId}/native-sessions/access`, {
        harness: "codex",
        sessionId: sessionId,
    });
    expect(otherComputer.status).toBe(401);
    expect(await otherComputer.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });

    const otherHarness = await fixture.request(`chat/native-sessions/access`, {
        harness: "pi",
        sessionId: sessionId,
    });
    expect(otherHarness.status).toBe(404);
    expect(await otherHarness.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    // Archiving a Session the Computer does not hold leaves it absent, as asked.
    const archived = await fixture.request(`chat/managed-sessions/archive`, {
        harness: "pi",
        sessionId: sessionId,
    });
    expect(archived.status).toBe(200);
    expect(await archived.json()).toEqual({ target: { harness: "pi", sessionId } });
    const retained = await fixture.request(`chat/native-sessions/access`, {
        harness: "codex",
        sessionId: sessionId,
    });
    expect(retained.status).toBe(200);
});

test("Given a draft Bot, When its owner sends the first message's creation request, Then the harness supplies the real session identity on the configured Computer", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const setup = { harness: "codex" };
    const setupComputersResponse = await fixture.request(`chat/setup/computers`, {});
    expect(setupComputersResponse.status).toBe(200);
    const setupComputers = v.parse(
        v.strictObject({
            computers: v.array(
                v.strictObject({
                    computerId: v.string(),
                    computerName: v.string(),
                    online: v.boolean(),
                    agents: v.array(v.strictObject({ harness: v.string(), label: v.string() })),
                }),
            ),
        }),
        await setupComputersResponse.json(),
    );
    expect(setupComputers).toMatchObject({
        computers: [{ computerId: fixture.runtime.computerId, online: true, agents: [{ harness: "codex" }] }],
    });
    expect((await fixture.request(`chat/setup`, setup)).status).toBe(202);

    const computerConfigurationResponse = await fixture.request(`chat/workspace`, {});
    expect(computerConfigurationResponse.status).toBe(200);
    expect(await computerConfigurationResponse.json()).toMatchObject({
        computer: { computerId: fixture.runtime.computerId, online: true, agents: [{ harness: "codex" }] },
    });
    const configuredSetupComputers = await fixture.request(`chat/setup/computers`, {});
    expect(configuredSetupComputers.status).toBe(200);
    expect(await configuredSetupComputers.json()).toMatchObject({ computers: [{ computerId: fixture.computerId }] });

    const settingsWithoutDirectory = await fixture.request(`chat/agent-settings`, { harness: setup.harness });
    expect(settingsWithoutDirectory.status).toBe(400);
    expect(
        (
            await fixture.request(`chat/agent-settings`, {
                harness: setup.harness,
                workspaceRef: ".",
            })
        ).status,
    ).toBe(200);
    expect(
        (
            await fixture.request(`chat/workspace/directory`, {
                directory: ".",
            })
        ).status,
    ).toBe(200);

    const opened = await fixture.request(`chat/managed-sessions/open`, {
        harness: setup.harness,
        configurations: [],
        conversationKey: "first-draft",
        workspaceRef: ".",
    });
    expect(opened.status).toBe(200);
    const access = v.parse(
        v.object({ target: targetSchema, credential: v.string(), ready: v.unknown() }),
        await opened.json(),
    );
    expect(access.target.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);
    expect(access.credential).toMatch(/^msession_/u);

    const listed = await fixture.request(`chat/managed-sessions`, {});
    expect(listed.status).toBe(200);
    const sessions = v.parse(
        v.object({
            sessions: v.array(
                v.object({
                    target: targetSchema,
                    status: v.object({ kind: v.string() }),
                    updatedAt: v.pipe(v.string(), v.isoTimestamp()),
                }),
            ),
        }),
        await listed.json(),
    );
    expect(sessions).toMatchObject({
        sessions: [
            {
                target: access.target,
                status: { kind: "idle" },
                updatedAt: AUTH_TIME.toISOString(),
            },
        ],
    });
});

for (const { reason, ...configuration } of [
    { reason: "missing", configId: "removed-setting", valueType: "select", value: "default", booleanValue: false },
    { reason: "changed type", configId: "model", valueType: "boolean", value: "", booleanValue: true },
    { reason: "removed value", configId: "model", valueType: "select", value: "removed-model", booleanValue: false },
]) {
    test(`Given a ${reason} Agent setting, When Chat creates a conversation, Then it reports a conflict and a corrected retry opens one fully configured session`, async ({
        cloud,
    }) => {
        await using fixture = await createChatFixture(cloud, [
            { harness: "configuration-test", label: "Settings Agent" },
        ]);
        expect((await fixture.request(`chat/setup`, { harness: "configuration-test" })).status).toBe(202);
        const input = {
            harness: "configuration-test",
            conversationKey: "configuration-retry",
            workspaceRef: ".",
        };
        const rejected = await fixture.request(`chat/managed-sessions/open`, {
            ...input,
            configurations: [configuration],
        });
        expect(rejected.status).toBe(409);
        expect(await rejected.json()).toMatchObject({ error: { code: "session_configuration_conflict" } });
        expect(await (await fixture.request(`chat/managed-sessions`, {})).json()).toEqual({
            sessions: [],
        });

        const configurations = [
            { configId: "model", valueType: "select", value: "test-large", booleanValue: false },
            { configId: "fast", valueType: "boolean", value: "", booleanValue: true },
            { configId: "effort", valueType: "select", value: "high", booleanValue: false },
        ];
        const opened = await fixture.request(`chat/managed-sessions/open`, { ...input, configurations });
        expect(opened.status).toBe(200);
        const access = v.parse(
            v.object({ target: targetSchema, credential: v.string(), ready: v.unknown() }),
            await opened.json(),
        );
        expect(access.credential).toMatch(/^msession_/u);
        const expectedReady = {
            configOptions: expect.arrayContaining([
                expect.objectContaining({ id: "model", currentValue: "test-large" }),
                expect.objectContaining({ id: "fast", booleanValue: true }),
                expect.objectContaining({ id: "effort", currentValue: "high" }),
            ]),
        };
        expect(access.ready).toMatchObject(expectedReady);
        const retried = await fixture.request(`chat/managed-sessions/open`, { ...input, configurations });
        expect(retried.status).toBe(200);
        expect(await retried.json()).toMatchObject({ target: access.target, ready: expectedReady });
        expect(await (await fixture.request(`chat/managed-sessions`, {})).json()).toMatchObject({
            sessions: [{ target: access.target }],
        });
    });
}

test("Given the answer to a new conversation's Session creation is lost, When the Computer restarts and its owner retries the start, Then the conversation is listed once and the retry opens the created Session", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    expect((await fixture.request(`chat/setup`, { harness: "codex" })).status).toBe(202);
    if (cloud.network === null) {
        throw new Error("The scenario requires a real response-loss proxy");
    }
    const input = { harness: "codex", conversationKey: "lost-creation", workspaceRef: ".", configurations: [] };
    const lost = cloud.network.interruptNextSessionCreation();
    await expect(fixture.request(`chat/managed-sessions/open`, input)).rejects.toBeInstanceOf(TypeError);
    expect(await lost).toBe(200);
    const listed = async () =>
        v.parse(
            v.object({ sessions: v.array(v.object({ target: targetSchema })) }),
            await (await fixture.request(`chat/managed-sessions`, {})).json(),
        ).sessions;
    const [owned, ...others] = await listed();
    expect(others).toEqual([]);
    expect(owned).toBeDefined();
    await fixture.runtime.disconnect();
    await fixture.runtime.reconnect();

    const retried = await fixture.request(`chat/managed-sessions/open`, input);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ target: owned?.target });
    expect(await listed()).toEqual([expect.objectContaining({ target: owned?.target })]);
});

test("Given a completed creation operation, When its first-send settings are changed on retry, Then Chat refuses the reused operation and keeps the original native conversation", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    expect((await fixture.request(`chat/setup`, { harness: "codex" })).status).toBe(202);
    const input = {
        harness: "codex",
        conversationKey: "conflicting-creation",
        workspaceRef: ".",
        configurations: [],
    };
    const first = await fixture.request(`chat/managed-sessions/open`, input);
    expect(first.status).toBe(200);
    const { target } = v.parse(v.object({ target: targetSchema }), await first.json());
    const refused = await fixture.request(`chat/managed-sessions/open`, {
        ...input,
        configurations: [{ configId: "model", valueType: "select", value: "test-large", booleanValue: false }],
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
    const listed = await fixture.request(`chat/managed-sessions`, {});
    expect(await listed.json()).toMatchObject({ sessions: [{ target }] });
});

test("Given a new conversation whose Session creation never reached the Computer, When its owner lists conversations, Then none is listed until a retry creates it", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    expect((await fixture.request(`chat/setup`, { harness: "codex" })).status).toBe(202);
    if (cloud.network === null) {
        throw new Error("The scenario requires a real request-loss proxy");
    }
    const input = {
        harness: "codex",
        conversationKey: "dropped-creation",
        workspaceRef: ".",
        configurations: [],
    };
    cloud.network.dropNextSessionCreation();
    await expect(fixture.request(`chat/managed-sessions/open`, input)).rejects.toBeInstanceOf(TypeError);
    const listed = async () =>
        v.parse(
            v.object({ sessions: v.array(v.object({ target: targetSchema, title: v.string() })) }),
            await (await fixture.request(`chat/managed-sessions`, {})).json(),
        ).sessions;
    expect(await listed()).toEqual([]);

    const retried = await fixture.request(`chat/managed-sessions/open`, input);
    expect(retried.status).toBe(200);
    const { target } = v.parse(v.object({ target: targetSchema }), await retried.json());
    expect(await listed()).toEqual([expect.objectContaining({ target })]);
});

test("Given an Agent whose model decides its effort levels, When Chat starts a conversation that lists the effort before the model, Then the new Session holds both selections", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud, [
        { harness: "dependent-settings-test", label: "Settings Agent" },
    ]);
    expect((await fixture.request(`chat/setup`, { harness: "dependent-settings-test" })).status).toBe(202);
    const opened = await fixture.request(`chat/managed-sessions/open`, {
        harness: "dependent-settings-test",
        conversationKey: "effort-before-model",
        workspaceRef: ".",
        configurations: [
            { configId: "effort", valueType: "select", value: "low", booleanValue: false },
            { configId: "model", valueType: "select", value: "test-large", booleanValue: false },
        ],
    });
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({
        ready: {
            configOptions: expect.arrayContaining([
                expect.objectContaining({ id: "model", currentValue: "test-large" }),
                expect.objectContaining({ id: "effort", currentValue: "low" }),
            ]),
        },
    });
});

test("Given dependent Agent settings, When applying a later selection changes an earlier one, Then Chat rejects creation instead of returning partially configured access", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud, [
        { harness: "dependent-settings-test", label: "Settings Agent" },
    ]);
    expect((await fixture.request(`chat/setup`, { harness: "dependent-settings-test" })).status).toBe(202);
    const response = await fixture.request(`chat/managed-sessions/open`, {
        harness: "dependent-settings-test",
        conversationKey: "dependent-settings",
        workspaceRef: ".",
        configurations: [
            { configId: "model", valueType: "select", value: "test-large", booleanValue: false },
            { configId: "mode", valueType: "select", value: "plan", booleanValue: false },
        ],
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "session_configuration_conflict" } });
    expect(await (await fixture.request(`chat/managed-sessions`, {})).json()).toEqual({
        sessions: [],
    });
});

test("Given a Bot connected through one Agent, When a Session uses another Agent, Then that Session reopens with its own Agent", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud, [
        { harness: "codex", label: "Codex" },
        { harness: "pi", label: "Pi" },
    ]);
    const setup = { harness: "codex" };
    expect((await fixture.request(`chat/setup`, setup)).status).toBe(202);

    const unavailable = await fixture.request(`chat/managed-sessions/open`, {
        harness: "claude-code",
        configurations: [],
        conversationKey: "unavailable-agent",
        workspaceRef: ".",
    });
    expect(unavailable.status).toBe(409);
    expect(await unavailable.json()).toMatchObject({ error: { code: "AGENT_UNAVAILABLE" } });

    const opened = await fixture.request(`chat/managed-sessions/open`, {
        harness: "pi",
        configurations: [],
        conversationKey: "agent-mismatch",
        workspaceRef: ".",
    });
    expect(opened.status).toBe(200);
    const access = v.parse(v.object({ harness: v.string(), target: targetSchema }), await opened.json());
    expect(access.harness).toBe("pi");

    const restored = await fixture.request(`chat/managed-sessions/resolve`, {
        harness: "pi",
        sessionId: access.target.sessionId,
    });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ harness: "pi" });
});

test("Given an imported native session, When its owner closes and explicitly imports it again, Then Chat reopens the canonical session without creating a duplicate", async ({
    cloud,
}) => {
    const nativeId = crypto.randomUUID();
    await using fixture = await createChatFixture(cloud, undefined, new Set([nativeId]));
    expect((await fixture.request(`chat/setup`, { harness: "codex" })).status).toBe(202);
    const identity = { harness: "codex", directory: "." };
    const listed = await fixture.request(`chat/native-sessions`, {
        ...identity,
        action: "list",
        cursor: null,
    });
    expect(listed.status).toBe(200);
    const discovery = v.parse(
        v.object({
            entries: v.array(v.object({ directory: v.string(), sessionId: v.string() })),
        }),
        await listed.json(),
    );
    const entry = v.parse(v.object({ directory: v.string(), sessionId: v.string() }), discovery.entries[0]);
    const sessionId = entry.sessionId;
    const path = `chat/native-sessions/${sessionId}/import`;
    const input = { ...identity, directory: entry.directory };
    const first = await fixture.request(path, input);
    expect(first.status).toBe(200);
    const opened = v.parse(v.object({ ready: v.object({ target: targetSchema }) }), await first.json());
    expect((await fixture.request("chat/managed-sessions/archive", opened.ready.target)).status).toBe(200);
    expect(await (await fixture.request("chat/managed-sessions", {})).json()).toEqual({ sessions: [] });
    const second = await fixture.request(path, input);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ready: { target: opened.ready.target } });
    const handoff = await fixture.request(`chat/native-sessions/continue`, {
        harness: "codex",
        sessionId: nativeId,
    });
    expect(handoff.status).toBe(200);
    expect(await handoff.json()).toMatchObject({ result: { ready: { target: opened.ready.target } } });
    const managed = await fixture.request(`chat/managed-sessions`, {});
    expect(await managed.json()).toMatchObject({ sessions: [{ target: opened.ready.target }] });
});

test("Given a Session the Computer holds with a running turn, When its owner archives it, Then it leaves the list, the Computer no longer holds it and archiving again succeeds", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    expect((await fixture.request(`chat/setup`, { harness: "codex" })).status).toBe(202);
    const opened = await fixture.request(`chat/managed-sessions/open`, {
        harness: "codex",
        configurations: [],
        conversationKey: "busy-archive",
        workspaceRef: ".",
    });
    const { target } = v.parse(v.object({ target: targetSchema }), await opened.json());
    await (await fixture.runtime.sessionClient(target, AbortSignal.timeout(10_000))).turns.submit(
        target,
        {
            content: "wait for steering",
            idempotencyKey: crypto.randomUUID(),
            attachments: [],
        },
        AbortSignal.timeout(10_000),
    );

    const archived = await fixture.request(`chat/managed-sessions/archive`, target);

    expect(archived.status).toBe(200);
    expect(await archived.json()).toEqual({ target });
    expect(await (await fixture.request(`chat/managed-sessions`, {})).json()).toEqual({ sessions: [] });
    expect(await fixture.runtime.api.managedSessions(AbortSignal.timeout(10_000))).toEqual([]);
    const reopened = await fixture.request(`chat/managed-sessions/open`, target);
    expect(reopened.status).toBe(404);
    expect(await reopened.json()).toMatchObject({
        error: {
            code: "NOT_FOUND",
            message:
                'This session is not in Morty Recent sessions. If you closed it in Morty, use "Open Session" to import or fork it again.',
        },
    });
    const repeated = await fixture.request(`chat/managed-sessions/archive`, target);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual({ target });
});

test("Given an archived native Session, When its owner opens it again from the Agent's sessions, Then it returns to the list as the same Session", async ({
    cloud,
}) => {
    const nativeId = crypto.randomUUID();
    await using fixture = await createChatFixture(cloud, undefined, new Set([nativeId]));
    expect((await fixture.request(`chat/setup`, { harness: "codex" })).status).toBe(202);
    const listed = await fixture.runtime.api.nativeSessions(
        { action: "list", harness: "codex", directory: ".", cursor: null },
        AbortSignal.timeout(10000),
    );
    if (listed.action !== "list") {
        throw new Error("Expected native sessions");
    }
    const nativeSession = listed.entries.find((entry) => entry.sessionId === nativeId);
    if (nativeSession === undefined) {
        throw new Error("Expected native session");
    }
    const open = async () => {
        const response = await fixture.request(`chat/native-sessions/${nativeId}/import`, {
            harness: "codex",
            directory: nativeSession.directory,
        });
        expect(response.status).toBe(200);
        return v.parse(v.object({ ready: v.object({ target: targetSchema }) }), await response.json()).ready.target;
    };
    const target = await open();
    expect((await fixture.request(`chat/managed-sessions/archive`, target)).status).toBe(200);
    expect(await (await fixture.request(`chat/managed-sessions`, {})).json()).toEqual({ sessions: [] });

    expect(await open()).toEqual(target);
    expect(await (await fixture.request(`chat/managed-sessions`, {})).json()).toMatchObject({
        sessions: [{ target }],
    });
});

for (const operation of ["managed-sessions/open", "managed-sessions/resolve"]) {
    test(`Given a managed Chat session, When ${operation} and archival run concurrently, Then the archived session stays archived and cannot be reopened through Morty`, async ({
        cloud,
    }) => {
        await using fixture = await createChatFixture(cloud);
        expect((await fixture.request(`chat/setup`, { harness: "codex" })).status).toBe(202);
        const opened = await fixture.request(`chat/managed-sessions/open`, {
            harness: "codex",
            configurations: [],
            conversationKey: "concurrent-archive",
            workspaceRef: ".",
        });
        const { target } = v.parse(v.object({ target: targetSchema }), await opened.json());

        const [reopened, archived] = await Promise.all([
            fixture.request(`chat/${operation}`, target),
            fixture.request(`chat/managed-sessions/archive`, target),
        ]);

        expect([200, 404]).toContain(reopened.status);
        expect(archived.status).toBe(200);
        expect(await archived.json()).toEqual({ target });
        const rejected = await fixture.request(`chat/managed-sessions/open`, target);
        expect(rejected.status).toBe(404);
        expect(await rejected.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
        const managed = await fixture.request(`chat/managed-sessions`, {});
        expect(await managed.json()).toEqual({ sessions: [] });
    });
}

test("Given the Computer is offline, When its owner archives a Session, Then archiving fails as retryable and the Session stays listed until a retry archives it", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    expect((await fixture.request(`chat/setup`, { harness: "codex" })).status).toBe(202);
    const opened = await fixture.request(`chat/managed-sessions/open`, {
        harness: "codex",
        configurations: [],
        conversationKey: "offline-archive",
        workspaceRef: ".",
    });
    const { target } = v.parse(v.object({ target: targetSchema }), await opened.json());
    await fixture.runtime.disconnect();

    const failed = await fixture.request(`chat/managed-sessions/archive`, target);

    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ error: { code: "computer_offline" } });
    await fixture.runtime.reconnect();
    expect(await (await fixture.request(`chat/managed-sessions`, {})).json()).toMatchObject({
        sessions: [{ target }],
    });
    const retried = await fixture.request(`chat/managed-sessions/archive`, target);
    expect(retried.status).toBe(200);
    expect(await (await fixture.request(`chat/managed-sessions`, {})).json()).toEqual({ sessions: [] });
});

test("Given a chat opened with a Session credential, When the computer's owner revokes all access, Then the Relay refuses that credential at once", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    expect((await fixture.request(`chat/setup`, { harness: "codex" })).status).toBe(202);
    const opened = await fixture.request(`chat/managed-sessions/open`, {
        harness: "codex",
        configurations: [],
        conversationKey: "revoked-while-open",
        workspaceRef: ".",
    });
    expect(opened.status).toBe(200);
    const access = v.parse(
        v.object({ computerId: v.string(), target: targetSchema, credential: v.string() }),
        await opened.json(),
    );
    const transport = new WsTransport();
    onTestFinished(transport.close);
    const client = new MortyClient({
        transport,
        endpoint: cloud.origin,
        computerId: access.computerId,
        credentialProvider: { credential: async () => access.credential },
    });
    onTestFinished(() => client.close());
    const readHistory = () =>
        client.events.list(access.target, new MortyPageRequest(1, ""), AbortSignal.timeout(15_000));
    await readHistory();

    const revoked = await fixture.request("identity/revoke-all-access", {
        successor: `morty_computer_v1_${"A".repeat(43)}`,
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ status: "access_revoked" });

    await expect(readHistory()).rejects.toMatchObject({ code: "credential_revoked" });
});

test("Given two browsers joined through links, When one disconnects the other browsers, Then only it and the computer keep access and the other's open chat window is refused", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    expect((await fixture.request(`chat/setup`, { harness: "codex" })).status).toBe(202);
    const share = async () => {
        const shared = await fixture.request("identity/transfers", { operationId: crypto.randomUUID() });
        return new URL(v.parse(v.object({ url: v.string() }), await shared.json()).url).hash.slice(6);
    };
    const redeem = async (code: string) =>
        await worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/v1/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code }),
            }),
            cloud.environment(),
        );
    const join = async () =>
        v.parse(v.object({ computerToken: v.string() }), await (await redeem(await share())).json()).computerToken;
    const owner = await join();
    const other = await join();
    const unused = await share();
    const asBrowser = (token: string, path: string, method = "GET", body?: object) =>
        fetchPublicApplication(
            new Request(`${APP_ORIGIN}/morty/api/${path}`, {
                method,
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
            cloud.environment(),
        );
    const opened = await asBrowser(other, `v1/computers/${fixture.computerId}/managed-sessions/open`, "POST", {
        harness: "codex",
        configurations: [],
        conversationKey: "other-browser-window",
        workspaceRef: ".",
    });
    expect(opened.status).toBe(200);
    const window = v.parse(
        v.object({ computerId: v.string(), target: targetSchema, credential: v.string() }),
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
    const readHistory = () =>
        client.events.list(window.target, new MortyPageRequest(1, ""), AbortSignal.timeout(15_000));
    await readHistory();

    const ended = await asBrowser(owner, `v1/computers/${fixture.computerId}/identity/other-browser-access`, "DELETE");

    expect(ended.status).toBe(200);
    expect(await ended.json()).toEqual({ status: "other_browser_access_ended" });
    expect((await asBrowser(owner, `v1/computers/${fixture.computerId}/session`)).status).toBe(200);
    expect((await fixture.request("session")).status).toBe(200);
    const refused = await asBrowser(other, `v1/computers/${fixture.computerId}/session`);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ error: { reason: "ACCESS_REVOKED" } });
    await expect(readHistory()).rejects.toMatchObject({ code: "credential_revoked" });
    expect((await redeem(unused)).status).toBe(410);
});

test("Given a browser connecting from a city, When it opens a link, Then the device list shows roughly where it joined, never what the browser claimed", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const shared = await fixture.request("identity/transfers", { operationId: crypto.randomUUID() });
    const code = new URL(v.parse(v.object({ url: v.string() }), await shared.json()).url).hash.slice(6);
    const redeemed = await cloud.dispatchFetch(`${APP_ORIGIN}/morty/api/v1/identity/transfers/redeem`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "Morty-Client-Location": encodeURIComponent(JSON.stringify({ city: "Elsewhere", country: "AQ" })),
        },
        body: JSON.stringify({ code, device: "iPhone · Safari" }),
        cf: { city: "Shanghai", country: "CN" },
    });
    expect(redeemed.status).toBe(200);

    const listed = v.parse(
        v.object({ devices: v.array(v.object({ label: v.nullable(v.string()), location: v.unknown() })) }),
        await (await fixture.request("identity/devices")).json(),
    );
    expect(listed.devices).toEqual([{ label: "iPhone · Safari", location: { city: "Shanghai", country: "CN" } }]);
});

test("Given a sharing link, When a browser redeems it through a Computer-scoped path with a claimed location, Then Morty refuses and lists no such device", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const shared = await fixture.request("identity/transfers", { operationId: crypto.randomUUID() });
    const code = new URL(v.parse(v.object({ url: v.string() }), await shared.json()).url).hash.slice(6);
    const redeemed = await cloud.dispatchFetch(
        `${APP_ORIGIN}/morty/api/v1/computers/${fixture.computerId}/identity/transfers/redeem`,
        {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "Morty-Client-Location": encodeURIComponent(JSON.stringify({ city: "Elsewhere", country: "AQ" })),
            },
            body: JSON.stringify({ code, device: "iPhone · Safari" }),
            cf: { city: "Shanghai", country: "CN" },
        },
    );
    expect(redeemed.status).toBe(404);

    const listed = v.parse(
        v.object({ devices: v.array(v.unknown()) }),
        await (await fixture.request("identity/devices")).json(),
    );
    expect(listed.devices).toEqual([]);
});

test("Given an existing conversation, When a repeated start is refused, Then the conversation remains listed", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud, [{ harness: "configuration-test", label: "Settings Agent" }]);
    expect((await fixture.request(`chat/setup`, { harness: "configuration-test" })).status).toBe(202);
    const input = { harness: "configuration-test", conversationKey: "audit-retry", workspaceRef: "." };
    const started = await fixture.request(`chat/managed-sessions/open`, { ...input, configurations: [] });
    expect(started.status).toBe(200);
    const { target } = v.parse(v.object({ target: targetSchema }), await started.json());
    expect(await (await fixture.request(`chat/managed-sessions`, {})).json()).toMatchObject({
        sessions: [{ target }],
    });
    const repeated = await fixture.request(`chat/managed-sessions/open`, { ...input, configurations: [] });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ target });
    const refused = await fixture.request(`chat/managed-sessions/open`, {
        ...input,
        configurations: [{ configId: "removed-setting", valueType: "select", value: "default", booleanValue: false }],
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
    const access = await fixture.request(`chat/native-sessions/access`, {
        harness: "configuration-test",
        sessionId: target.sessionId,
    });
    const listed = await (await fixture.request(`chat/managed-sessions`, {})).json();
    expect(access.status).toBe(200);
    expect(listed).toMatchObject({ sessions: [{ target }] });
});
