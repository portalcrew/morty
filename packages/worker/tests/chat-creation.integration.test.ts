import { fileURLToPath } from "node:url";
import { MortyClient, MortyPageRequest, WsTransport } from "@morty-build/client";
import type { SessionConfigurationSelection } from "@morty-build/client/protocol";
import * as v from "valibot";
import { afterEach, test as baseTest, beforeEach, expect, onTestFinished, vi } from "vitest";
import type { ControlledAgent } from "../../../tests/support/fake-daemon/runtime.ts";
import { createOwnerApi } from "../../../tests/support/owner-api.ts";
import { ApiConnectionError } from "../../web/src/services/api/worker-api-transport.ts";
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
        credential: identity.token,
        request,
        runtime,
        [Symbol.asyncDispose]: () => runtime[Symbol.asyncDispose](),
    };
}

test("Given an archived conversation, When the original creation request is retried, Then its receipt cannot restore the archived Session", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const signal = AbortSignal.timeout(30_000);
    await fixture.runtime.api.verifyAgent("codex", signal);
    const settings = {
        harness: "codex",
        configurations: [],
        workspaceRef: ".",
        workspaceLabel: ".",
    };
    const key = "archived-creation-retry";
    const { target } = await fixture.runtime.api.createConversation(key, settings, signal);
    expect((await fixture.runtime.api.createConversation(key, settings, signal)).target).toEqual(target);
    await fixture.runtime.api.archiveManagedSession(target, signal);
    expect(await fixture.runtime.api.managedSessions(signal)).toEqual([]);
    const refusedBeforeReplay = fixture.runtime.api.managedSession(target, signal);
    await expect(refusedBeforeReplay).rejects.toMatchObject({ code: "NOT_FOUND", status: null });
    await expect(refusedBeforeReplay).rejects.toThrow(
        'This session is not in Morty Recent sessions. If you closed it in Morty, use "Open Session" to import or fork it again.',
    );
    expect((await fixture.runtime.api.createConversation(key, settings, signal)).target).toEqual(target);
    expect(await fixture.runtime.api.managedSessions(signal)).toEqual([]);
    await expect(fixture.runtime.api.managedSession(target, signal)).rejects.toMatchObject({
        code: "NOT_FOUND",
        status: null,
    });
});

test("Given a paired computer, When its owner selects and creates with harness, Then setup and session access expose the same harness", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const signal = AbortSignal.timeout(30_000);
    await fixture.runtime.api.verifyAgent("codex", signal);
    const workspace = await fixture.request("chat/workspace", {});
    expect(await workspace.json()).toMatchObject({ computer: { agents: [{ harness: "codex" }] } });
    const access = await fixture.runtime.api.createConversation(
        "unified-harness",
        {
            harness: "codex",
            configurations: [],
            workspaceRef: ".",
            workspaceLabel: ".",
        },
        signal,
    );
    expect(access).toMatchObject({ harness: "codex", target: { harness: "codex" } });
    expect(access).not.toHaveProperty("agentRef");
    expect(access).not.toHaveProperty("agentId");
    const { target } = v.parse(v.object({ target: targetSchema }), access);
    expect(await fixture.runtime.api.managedSession(target, signal)).toMatchObject({
        harness: "codex",
        result: { target },
    });
});

test("Given a computer addressed by its identity, When its owner requests access to a Session the Computer does not hold, Then Chat refuses to mint a credential while held Sessions remain usable", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const signal = AbortSignal.timeout(30_000);
    await fixture.runtime.api.verifyAgent("codex", signal);
    await expect(
        fixture.runtime.api.connectSession(
            {
                harness: "codex",
                sessionId: "chat_unowned_security_audit",
            },
            signal,
        ),
    ).rejects.toMatchObject({ code: "session_not_found" });

    const opened = await fixture.runtime.api.createConversation(
        "security-audit-owned",
        {
            harness: "codex",
            configurations: [],
            workspaceRef: ".",
            workspaceLabel: ".",
        },
        signal,
    );
    const { sessionId } = opened.target;
    const connected = await fixture.runtime.api.connectSession({ harness: "codex", sessionId }, signal);
    onTestFinished(connected.close);
    await expect(connected.sessions.readConfiguration({ harness: "codex", sessionId }, signal)).resolves.toBeDefined();

    // Another computer identity opens nothing with this credential, even for a Session the caller owns.
    const anotherComputer = await cloud.createAnonymousUser();
    const otherComputer = await fixture.request(`chat/computers/${anotherComputer.computerId}/native-sessions/access`, {
        harness: "codex",
        sessionId: sessionId,
    });
    expect(otherComputer.status).toBe(401);
    expect(await otherComputer.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });

    await expect(fixture.runtime.api.connectSession({ harness: "pi", sessionId }, signal)).rejects.toMatchObject({
        code: "session_not_found",
    });
    // Archiving a Session the Computer does not hold leaves it absent, as asked.
    await expect(
        fixture.runtime.api.archiveManagedSession(
            {
                harness: "pi",
                sessionId: sessionId,
            },
            signal,
        ),
    ).resolves.toBeUndefined();
    await expect(connected.sessions.readConfiguration({ harness: "codex", sessionId }, signal)).resolves.toBeDefined();
});

test("Given a draft Bot, When its owner sends the first message's creation request, Then the harness supplies the real session identity on the configured Computer", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const setup = { harness: "codex" };
    const signal = AbortSignal.timeout(30_000);
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
    await fixture.runtime.api.verifyAgent(setup.harness, signal);

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
    await expect(fixture.runtime.api.agentSettings(setup.harness, ".", signal)).resolves.toBeDefined();
    await expect(fixture.runtime.api.directory(".", signal)).resolves.toBeDefined();

    const access = await fixture.runtime.api.createConversation(
        "first-draft",
        {
            harness: setup.harness,
            configurations: [],
            workspaceRef: ".",
            workspaceLabel: ".",
        },
        signal,
    );
    expect(access.target.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);
    expect(access.credential).toMatch(/^msession_/u);

    const sessions = v.parse(
        v.array(
            v.object({
                target: targetSchema,
                status: v.object({ kind: v.string() }),
                updatedAt: v.pipe(v.string(), v.isoTimestamp()),
            }),
        ),
        await fixture.runtime.api.managedSessions(signal),
    );
    expect(sessions).toMatchObject([
        {
            target: access.target,
            status: { kind: "idle" },
            updatedAt: AUTH_TIME.toISOString(),
        },
    ]);
});

for (const { reason, ...configuration } of [
    { reason: "missing", configId: "removed-setting", type: "select", value: "default" },
    { reason: "changed type", configId: "model", type: "boolean", booleanValue: true },
    { reason: "removed value", configId: "model", type: "select", value: "removed-model" },
] satisfies readonly (SessionConfigurationSelection & { readonly reason: string })[]) {
    test(`Given a ${reason} Agent setting, When Chat creates a conversation, Then it reports a conflict and a corrected retry opens one fully configured session`, async ({
        cloud,
    }) => {
        await using fixture = await createChatFixture(cloud, [
            { harness: "configuration-test", label: "Settings Agent" },
        ]);
        const signal = AbortSignal.timeout(30_000);
        await fixture.runtime.api.verifyAgent("configuration-test", signal);
        const settings = {
            harness: "configuration-test",
            workspaceRef: ".",
            workspaceLabel: ".",
        };
        await expect(
            fixture.runtime.api.createConversation(
                "configuration-retry",
                {
                    ...settings,
                    configurations: [configuration],
                },
                signal,
            ),
        ).rejects.toMatchObject({ code: "session_configuration_conflict" });
        expect(await fixture.runtime.api.managedSessions(signal)).toEqual([]);

        const configurations = [
            { configId: "model", type: "select", value: "test-large" },
            { configId: "fast", type: "boolean", booleanValue: true },
            { configId: "effort", type: "select", value: "high" },
        ] satisfies readonly SessionConfigurationSelection[];
        const access = await fixture.runtime.api.createConversation(
            "configuration-retry",
            { ...settings, configurations },
            signal,
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
        const retried = await fixture.runtime.api.createConversation(
            "configuration-retry",
            { ...settings, configurations },
            signal,
        );
        expect(retried).toMatchObject({ target: access.target, ready: expectedReady });
        expect(await fixture.runtime.api.managedSessions(signal)).toMatchObject([{ target: access.target }]);
    });
}

test("Given the answer to a new conversation's Session creation is lost, When the Computer restarts and its owner retries the start, Then the conversation is listed once and the retry opens the created Session", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const signal = AbortSignal.timeout(30_000);
    await fixture.runtime.api.verifyAgent("codex", signal);
    if (cloud.network === null) {
        throw new Error("The scenario requires a real response-loss proxy");
    }
    const owner = createOwnerApi({
        origin: cloud.network.origin,
        computerId: fixture.computerId,
        credential: fixture.credential,
        encryptionAccess: await fixture.runtime.encryptionAccess(signal),
        request: (value) => fetch(value),
    });
    onTestFinished(owner.close);
    const input = { harness: "codex", workspaceRef: ".", workspaceLabel: ".", configurations: [] };
    const lost = cloud.network.interruptNextSessionCreation();
    await expect(owner.api.createConversation("lost-creation", input, signal)).rejects.toBeInstanceOf(
        ApiConnectionError,
    );
    expect(await lost).toBe(200);
    const listed = async () => await owner.api.managedSessions(signal);
    const [owned, ...others] = await listed();
    expect(others).toEqual([]);
    expect(owned).toBeDefined();
    await fixture.runtime.disconnect();
    await fixture.runtime.reconnect();

    const retried = await owner.api.createConversation("lost-creation", input, signal);
    expect(retried).toMatchObject({ target: owned?.target });
    expect(await listed()).toEqual([expect.objectContaining({ target: owned?.target })]);
});

test("Given a completed creation operation, When its first-send settings are changed on retry, Then Chat refuses the reused operation and keeps the original native conversation", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const signal = AbortSignal.timeout(30_000);
    await fixture.runtime.api.verifyAgent("codex", signal);
    const input = {
        harness: "codex",
        workspaceRef: ".",
        workspaceLabel: ".",
        configurations: [],
    };
    const { target } = await fixture.runtime.api.createConversation("conflicting-creation", input, signal);
    await expect(
        fixture.runtime.api.createConversation(
            "conflicting-creation",
            {
                ...input,
                configurations: [{ configId: "model", type: "select", value: "test-large" }],
            },
            signal,
        ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await fixture.runtime.api.managedSessions(signal)).toMatchObject([{ target }]);
});

test("Given a new conversation whose Session creation never reached the Computer, When its owner lists conversations, Then none is listed until a retry creates it", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const signal = AbortSignal.timeout(30_000);
    await fixture.runtime.api.verifyAgent("codex", signal);
    if (cloud.network === null) {
        throw new Error("The scenario requires a real request-loss proxy");
    }
    const owner = createOwnerApi({
        origin: cloud.network.origin,
        computerId: fixture.computerId,
        credential: fixture.credential,
        encryptionAccess: await fixture.runtime.encryptionAccess(signal),
        request: (value) => fetch(value),
    });
    onTestFinished(owner.close);
    const input = {
        harness: "codex",
        workspaceRef: ".",
        workspaceLabel: ".",
        configurations: [],
    };
    cloud.network.dropNextSessionCreation();
    await expect(owner.api.createConversation("dropped-creation", input, signal)).rejects.toBeInstanceOf(
        ApiConnectionError,
    );
    const listed = async () => await owner.api.managedSessions(signal);
    expect(await listed()).toEqual([]);

    const { target } = await owner.api.createConversation("dropped-creation", input, signal);
    expect(await listed()).toEqual([expect.objectContaining({ target })]);
});

test("Given an Agent whose model decides its effort levels, When Chat starts a conversation that lists the effort before the model, Then the new Session holds both selections", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud, [
        { harness: "dependent-settings-test", label: "Settings Agent" },
    ]);
    const signal = AbortSignal.timeout(30_000);
    await fixture.runtime.api.verifyAgent("dependent-settings-test", signal);
    const opened = await fixture.runtime.api.createConversation(
        "effort-before-model",
        {
            harness: "dependent-settings-test",
            workspaceRef: ".",
            workspaceLabel: ".",
            configurations: [
                { configId: "effort", type: "select", value: "low" },
                { configId: "model", type: "select", value: "test-large" },
            ],
        },
        signal,
    );
    expect(opened).toMatchObject({
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
    const signal = AbortSignal.timeout(30_000);
    await fixture.runtime.api.verifyAgent("dependent-settings-test", signal);
    await expect(
        fixture.runtime.api.createConversation(
            "dependent-settings",
            {
                harness: "dependent-settings-test",
                workspaceRef: ".",
                workspaceLabel: ".",
                configurations: [
                    { configId: "model", type: "select", value: "test-large" },
                    { configId: "mode", type: "select", value: "plan" },
                ],
            },
            signal,
        ),
    ).rejects.toMatchObject({ code: "session_configuration_conflict" });
    expect(await fixture.runtime.api.managedSessions(signal)).toEqual([]);
});

test("Given a Bot connected through one Agent, When a Session uses another Agent, Then that Session reopens with its own Agent", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud, [
        { harness: "codex", label: "Codex" },
        { harness: "pi", label: "Pi" },
    ]);
    const setup = { harness: "codex" };
    const signal = AbortSignal.timeout(30_000);
    await fixture.runtime.api.verifyAgent(setup.harness, signal);

    await expect(
        fixture.runtime.api.createConversation(
            "unavailable-agent",
            {
                harness: "claude-code",
                configurations: [],
                workspaceRef: ".",
                workspaceLabel: ".",
            },
            signal,
        ),
    ).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });

    const access = await fixture.runtime.api.createConversation(
        "agent-mismatch",
        {
            harness: "pi",
            configurations: [],
            workspaceRef: ".",
            workspaceLabel: ".",
        },
        signal,
    );
    expect(access.harness).toBe("pi");

    const restored = await fixture.runtime.api.managedSession(
        {
            harness: "pi",
            sessionId: access.target.sessionId,
        },
        signal,
    );
    expect(restored).toMatchObject({ harness: "pi" });
});

test("Given an imported native session, When its owner closes and explicitly imports it again, Then Chat reopens the canonical session without creating a duplicate", async ({
    cloud,
}) => {
    const nativeId = crypto.randomUUID();
    await using fixture = await createChatFixture(cloud, undefined, new Set([nativeId]));
    const signal = AbortSignal.timeout(30_000);
    await fixture.runtime.api.verifyAgent("codex", signal);
    const identity = { harness: "codex", directory: "." };
    const listed = await fixture.runtime.api.nativeSessions(
        {
            ...identity,
            action: "list",
            cursor: null,
        },
        signal,
    );
    if (listed.action !== "list") {
        throw new Error("Expected native session list");
    }
    const entry = v.parse(v.object({ directory: v.string(), sessionId: v.string() }), listed.entries[0]);
    const sessionId = entry.sessionId;
    const input = { ...identity, directory: entry.directory, action: "import", sessionId } satisfies Parameters<
        typeof fixture.runtime.api.nativeSessions
    >[0];
    const first = await fixture.runtime.api.nativeSessions(input, signal);
    if (first.action !== "import") {
        throw new Error("Expected imported Session");
    }
    await fixture.runtime.api.archiveManagedSession(first.ready.target, signal);
    expect(await fixture.runtime.api.managedSessions(signal)).toEqual([]);
    const second = await fixture.runtime.api.nativeSessions(input, signal);
    expect(second).toMatchObject({ ready: { target: first.ready.target } });
    const handoff = await fixture.runtime.api.continueNativeSession("codex", nativeId, signal);
    expect(handoff).toMatchObject({ result: { ready: { target: first.ready.target } } });
    expect(await fixture.runtime.api.managedSessions(signal)).toMatchObject([{ target: first.ready.target }]);
});

test("Given a Session the Computer holds with a running turn, When its owner archives it, Then it leaves the list, the Computer no longer holds it and archiving again succeeds", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const signal = AbortSignal.timeout(30_000);
    await fixture.runtime.api.verifyAgent("codex", signal);
    const { target } = await fixture.runtime.api.createConversation(
        "busy-archive",
        {
            harness: "codex",
            configurations: [],
            workspaceRef: ".",
            workspaceLabel: ".",
        },
        signal,
    );
    await (await fixture.runtime.sessionClient(target, AbortSignal.timeout(10_000))).turns.submit(
        target,
        {
            content: "wait for steering",
            idempotencyKey: crypto.randomUUID(),
            attachments: [],
        },
        AbortSignal.timeout(10_000),
    );

    await fixture.runtime.api.archiveManagedSession(target, signal);
    expect(await fixture.runtime.api.managedSessions(signal)).toEqual([]);
    const reopened = fixture.runtime.api.managedSession(target, signal);
    await expect(reopened).rejects.toMatchObject({ code: "NOT_FOUND", status: null });
    await expect(reopened).rejects.toThrow(
        'This session is not in Morty Recent sessions. If you closed it in Morty, use "Open Session" to import or fork it again.',
    );
    await expect(fixture.runtime.api.archiveManagedSession(target, signal)).resolves.toBeUndefined();
});

test("Given an archived native Session, When its owner opens it again from the Agent's sessions, Then it returns to the list as the same Session", async ({
    cloud,
}) => {
    const nativeId = crypto.randomUUID();
    await using fixture = await createChatFixture(cloud, undefined, new Set([nativeId]));
    const signal = AbortSignal.timeout(30_000);
    await fixture.runtime.api.verifyAgent("codex", signal);
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
        const result = await fixture.runtime.api.nativeSessions(
            {
                action: "import",
                harness: "codex",
                directory: nativeSession.directory,
                sessionId: nativeId,
            },
            signal,
        );
        if (result.action !== "import") {
            throw new Error("Expected imported Session");
        }
        return result.ready.target;
    };
    const target = await open();
    await fixture.runtime.api.archiveManagedSession(target, signal);
    expect(await fixture.runtime.api.managedSessions(signal)).toEqual([]);

    expect(await open()).toEqual(target);
    expect(await fixture.runtime.api.managedSessions(signal)).toMatchObject([{ target }]);
});

for (const operation of ["managed-sessions/open", "managed-sessions/resolve"]) {
    test(`Given a managed Chat session, When ${operation} and archival run concurrently, Then the archived session stays archived and cannot be reopened through Morty`, async ({
        cloud,
    }) => {
        await using fixture = await createChatFixture(cloud);
        const signal = AbortSignal.timeout(30_000);
        await fixture.runtime.api.verifyAgent("codex", signal);
        const { target } = await fixture.runtime.api.createConversation(
            "concurrent-archive",
            {
                harness: "codex",
                configurations: [],
                workspaceRef: ".",
                workspaceLabel: ".",
            },
            signal,
        );

        const [reopened, archived] = await Promise.allSettled([
            operation === "managed-sessions/open"
                ? fixture.runtime.api.connectSession(target, signal)
                : fixture.runtime.api.managedSession(target, signal),
            fixture.runtime.api.archiveManagedSession(target, signal),
        ]);

        if (reopened.status === "rejected") {
            expect(reopened.reason).toMatchObject({
                code: operation === "managed-sessions/open" ? "session_not_found" : "NOT_FOUND",
            });
        } else if (reopened.value instanceof MortyClient) {
            reopened.value.close();
        }
        expect(archived.status).toBe("fulfilled");
        await expect(fixture.runtime.api.connectSession(target, signal)).rejects.toMatchObject({
            code: "session_not_found",
        });
        expect(await fixture.runtime.api.managedSessions(signal)).toEqual([]);
    });
}

test("Given the Computer is offline, When its owner archives a Session, Then archiving fails as retryable and the Session stays listed until a retry archives it", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const signal = AbortSignal.timeout(30_000);
    await fixture.runtime.api.verifyAgent("codex", signal);
    const { target } = await fixture.runtime.api.createConversation(
        "offline-archive",
        {
            harness: "codex",
            configurations: [],
            workspaceRef: ".",
            workspaceLabel: ".",
        },
        signal,
    );
    await fixture.runtime.disconnect();

    await expect(fixture.runtime.api.archiveManagedSession(target, signal)).rejects.toMatchObject({
        code: "computer_offline",
        status: 503,
    });
    await fixture.runtime.reconnect();
    expect(await fixture.runtime.api.managedSessions(signal)).toMatchObject([{ target }]);
    await expect(fixture.runtime.api.archiveManagedSession(target, signal)).resolves.toBeUndefined();
    expect(await fixture.runtime.api.managedSessions(signal)).toEqual([]);
});

test("Given a chat opened with a Session credential, When the computer's owner revokes all access, Then the Relay refuses that credential at once", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const signal = AbortSignal.timeout(30_000);
    await fixture.runtime.api.verifyAgent("codex", signal);
    const access = await fixture.runtime.api.createConversation(
        "revoked-while-open",
        {
            harness: "codex",
            configurations: [],
            workspaceRef: ".",
            workspaceLabel: ".",
        },
        signal,
    );
    const transport = new WsTransport();
    onTestFinished(transport.close);
    const client = new MortyClient({
        transport,
        encryption: { access: await fixture.runtime.encryptionAccess(AbortSignal.timeout(15_000)) },
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
    await fixture.runtime.api.verifyAgent("codex", AbortSignal.timeout(30_000));
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
    const browserApi = createOwnerApi({
        origin: cloud.origin,
        computerId: fixture.computerId,
        credential: other,
        encryptionAccess: await fixture.runtime.encryptionAccess(AbortSignal.timeout(15_000)),
        request: (value) => fetchPublicApplication(value, cloud.environment()),
    });
    onTestFinished(browserApi.close);
    const window = await browserApi.api.createConversation(
        "other-browser-window",
        {
            harness: "codex",
            configurations: [],
            workspaceRef: ".",
            workspaceLabel: ".",
        },
        AbortSignal.timeout(30_000),
    );
    const transport = new WsTransport();
    onTestFinished(transport.close);
    const client = new MortyClient({
        transport,
        encryption: { access: await fixture.runtime.encryptionAccess(AbortSignal.timeout(15_000)) },
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
    const signal = AbortSignal.timeout(30_000);
    await fixture.runtime.api.verifyAgent("configuration-test", signal);
    const settings = { harness: "configuration-test", workspaceRef: ".", workspaceLabel: ".", configurations: [] };
    const { target } = await fixture.runtime.api.createConversation("audit-retry", settings, signal);
    expect(await fixture.runtime.api.managedSessions(signal)).toMatchObject([{ target }]);
    expect(await fixture.runtime.api.createConversation("audit-retry", settings, signal)).toMatchObject({ target });
    await expect(
        fixture.runtime.api.createConversation(
            "audit-retry",
            {
                ...settings,
                configurations: [{ configId: "removed-setting", type: "select", value: "default" }],
            },
            signal,
        ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    const client = await fixture.runtime.api.connectSession(target, signal);
    onTestFinished(client.close);
    await expect(client.sessions.readConfiguration(target, signal)).resolves.toBeDefined();
    expect(await fixture.runtime.api.managedSessions(signal)).toMatchObject([{ target }]);
});
