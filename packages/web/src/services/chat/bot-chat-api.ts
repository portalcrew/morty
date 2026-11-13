import type { ForkMortyNativeSessionRequest } from "@morty-build/client";
import { MortyClient, type WsTransport } from "@morty-build/client";
import { sameNativeSession } from "@morty-build/client/native-session";
import type { NativeSessionRequest } from "@morty-build/client/protocol";
import {
    decodeAgentSettingsDiscoveredEvent,
    decodeComputerDiagnosticsResult,
    decodeNativeSessionEvents,
    decodeNativeSessionResult,
    decodeSessionAccessCredential,
    decodeSessionReadyEvent,
    decodeWorkspaceEntriesEvent,
    type Identifier,
    isDirectoryPath,
    isIdentifier,
    type NativeSessionTarget,
    type SessionConfigOption,
    type SessionConfigurationSelection,
} from "@morty-build/client/protocol";
import * as v from "valibot";
import type { ApiResponseSnapshot, ApiTransport } from "../api/api-transport.ts";
import type { ApiRequest } from "../api/calls/call.ts";
import { chatCalls } from "../api/calls/chat.ts";
import { managementCalls } from "../api/calls/management.ts";
import { recordBrowserDiagnostic } from "../diagnostics/browser-diagnostics.ts";
import { type AgentModelCatalog, modelSelections } from "../diagnostics/model-catalog.ts";
import { CloudApiError, ManagementApi } from "../management/management-api.ts";

const identifier = v.custom<Identifier>(isIdentifier);
const sessionCredentialSchema = v.pipe(
    v.string(),
    v.check((credential) => {
        try {
            decodeSessionAccessCredential(credential);
            return true;
        } catch {
            return false;
        }
    }, "Invalid Session credential"),
);
const nativeSessionTargetSchema = v.pipe(v.strictObject({ harness: identifier, sessionId: identifier }), v.readonly());
const accessSchema = v.pipe(
    v.strictObject({
        computerId: identifier,
        target: nativeSessionTargetSchema,
        credential: sessionCredentialSchema,
        expiresAt: v.pipe(v.string(), v.isoTimestamp()),
        ready: v.unknown(),
        harness: identifier,
        workspaceRef: v.custom<string>(isDirectoryPath),
    }),
    v.readonly(),
);
export type ChatAccess = v.InferOutput<typeof accessSchema>;
const managedSessionStatusSchema = v.variant("kind", [
    v.pipe(
        v.object({
            kind: v.literal("idle"),
            /** Present when the Computer reports that the Session's last turn failed. */
            failedTurn: v.optional(
                v.pipe(v.object({ code: v.string(), commandId: identifier, message: v.string() }), v.readonly()),
            ),
        }),
        v.readonly(),
    ),
    v.pipe(v.object({ commandId: identifier, kind: v.literal("working") }), v.readonly()),
]);
/** A Session the Computer holds, as it describes it. */
const managedSessionSchema = v.pipe(
    v.object({
        title: v.string(),
        updatedAt: v.pipe(v.string(), v.isoTimestamp()),
        directoryLabel: v.string(),
        directory: v.string(),
        /** Whether the Computer has received the Session's first prompt, which gives the Session its title. */
        prompted: v.boolean(),
        target: nativeSessionTargetSchema,
        status: managedSessionStatusSchema,
    }),
    v.readonly(),
);
export type ManagedChatSession = v.InferOutput<typeof managedSessionSchema>;
const chatComputerSchema = v.object({
    computerId: identifier,
    computerName: v.string(),
    online: v.boolean(),
    agents: v.array(
        v.object({
            harness: identifier,
            label: v.string(),
        }),
    ),
});
export type ChatComputer = v.InferOutput<typeof chatComputerSchema>;
const computerConfigurationSchema = v.object({ computer: chatComputerSchema });
const networkDiagnosticSchema = v.strictObject({
    computerLatencyMs: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});
export type BotComputerConfiguration = v.InferOutput<typeof computerConfigurationSchema>;
export type ChatAgentSelection = {
    readonly harness: Identifier;
    readonly label: string;
};
/**
 * Whether the Computer can take a new conversation now. The setup notice and the draft's settings both follow this one
 * rule, so they never disagree about why a draft cannot start.
 */
export function computerAgentAvailability(computer: ChatComputer): "no-agent" | "offline" | "available" {
    if (computer.agents.length === 0) {
        return "no-agent";
    }
    return computer.online ? "available" : "offline";
}
export function connectedChatComputerAgents(computer: ChatComputer): readonly ChatAgentSelection[] {
    return computer.online ? computer.agents : [];
}
export interface ChatDraftConfiguration {
    readonly harness: string;
    readonly workspaceRef: string;
    readonly workspaceLabel: string;
    readonly configurations: readonly SessionConfigurationSelection[];
}
interface AgentSettingsResult {
    readonly options: readonly SessionConfigOption[];
    readonly catalog: AgentModelCatalog;
}
export type ConversationActiveTurn =
    | { readonly kind: "idle" }
    | { readonly kind: "running"; readonly commandId: string; readonly turnId: string };
const sessionAccessSchema = v.object({
    target: nativeSessionTargetSchema,
    computerId: identifier,
    credential: sessionCredentialSchema,
    expiresAt: v.pipe(v.string(), v.isoTimestamp()),
});
const localSessionEntrySchema = v.object({
    sessionId: identifier,
    title: v.string(),
    directory: v.string(),
    directoryLabel: v.string(),
    updatedAt: v.nullable(v.string()),
});
const managedSdkSessionSchema = v.object({
    harness: identifier,
    ready: v.unknown(),
    entry: localSessionEntrySchema,
});
const localSessionSchema = v.object({
    harness: identifier,
    result: v.unknown(),
    entry: localSessionEntrySchema,
});

function continuedSession(value: unknown) {
    const stored = v.parse(localSessionSchema, value);
    const result = decodeNativeSessionResult(JSON.stringify(stored.result));
    if (result.action !== "import") {
        throw new CloudApiError("INVALID_SESSION", "The continued Chat session is invalid.");
    }
    return { ...stored, result };
}

export class BotChatApi {
    readonly #fetchRequest: ApiTransport["fetch"];
    readonly #origin: string;
    readonly #computerId: string;
    readonly #getToken: (signal: AbortSignal) => Promise<string | null>;
    readonly #replacedToken: ((rejected: string, signal: AbortSignal) => Promise<string | null>) | undefined;
    readonly #credentialRejected: (() => void) | undefined;
    readonly #sessionClients = new Set<MortyClient>();
    readonly #sessionTransport: () => WsTransport;
    readonly #lifetime = new AbortController();
    readonly #waitForChange: ApiTransport["waitForChange"];
    readonly readComputerPairing: ManagementApi["readComputerPairing"];
    constructor(options: {
        readonly fetchRequest: ApiTransport["fetch"];
        /** Borrow the application's Computer connection; this API owns only its Session clients. */
        readonly sessionTransport: () => WsTransport;
        readonly origin: string;
        readonly computerId: string;
        readonly getToken: (signal: AbortSignal) => Promise<string | null>;
        /**
         * The access that replaced `rejected`, once whoever replaces it has finished, or null when nothing did. A
         * request refused while another tab replaced its access is sent again with the replacement.
         */
        readonly replacedToken?: (rejected: string, signal: AbortSignal) => Promise<string | null>;
        /** Told when the Worker refuses the access as unauthenticated; whoever owns that access decides what it means. */
        readonly credentialRejected?: () => void;
        readonly waitForChange: ApiTransport["waitForChange"];
    }) {
        this.#origin = v.parse(v.pipe(v.string(), v.url()), options.origin);
        this.#computerId = v.parse(identifier, options.computerId);
        this.#fetchRequest = options.fetchRequest;
        this.#sessionTransport = options.sessionTransport;
        this.#getToken = options.getToken;
        this.#replacedToken = options.replacedToken;
        this.#credentialRejected = options.credentialRejected;
        this.#waitForChange = options.waitForChange;
        const management = new ManagementApi(options);
        this.readComputerPairing = management.readComputerPairing;
    }
    readonly close = (): void => {
        this.#lifetime.abort(new DOMException("The Computer workspace was closed.", "AbortError"));
        for (const client of this.#sessionClients) {
            client.close();
        }
        this.#sessionClients.clear();
    };
    readonly daemonDiagnostics = async (signal: AbortSignal) =>
        decodeComputerDiagnosticsResult(
            JSON.stringify(
                await this.#request(
                    chatCalls.daemonDiagnostics({ origin: this.#origin, computerId: this.#computerId }),
                    signal,
                ),
            ),
        );
    readonly networkDiagnostic = async (signal: AbortSignal) =>
        v.parse(
            networkDiagnosticSchema,
            await this.#request(
                chatCalls.networkDiagnostic({ origin: this.#origin, computerId: this.#computerId }),
                signal,
            ),
        );
    readonly createConversation = async (
        conversationKey: string,
        settings: ChatDraftConfiguration,
        signal: AbortSignal,
    ): Promise<ChatAccess> =>
        v.parse(
            accessSchema,
            await this.#request(
                chatCalls.createConversation({
                    origin: this.#origin,
                    computerId: this.#computerId,
                    input: {
                        harness: settings.harness,
                        configurations: settings.configurations,
                        conversationKey,
                        workspaceRef: settings.workspaceRef,
                    },
                }),
                signal,
            ),
        );
    readonly conversationSession = (
        access: ChatAccess,
        activeTurn: ConversationActiveTurn,
        directoryLabel = access.workspaceRef,
        title = "Untitled session",
    ) => ({
        harness: access.harness,
        result: {
            action: "conversation" as const,
            access,
            activeTurn,
            target: access.target,
            ready: decodeSessionReadyEvent(JSON.stringify(access.ready)),
        },
        entry: {
            sessionId: access.target.sessionId,
            title,
            directory: access.workspaceRef,
            directoryLabel,
            updatedAt: null,
        },
    });
    readonly managedSessions = async (signal: AbortSignal) =>
        v.parse(
            v.object({ sessions: v.array(managedSessionSchema) }),
            await this.#request(
                chatCalls.managedSessions({ origin: this.#origin, computerId: this.#computerId }),
                signal,
            ),
        ).sessions;
    /** Resolves once the Computer no longer holds the Session; otherwise rejects with the Computer's failure. */
    readonly archiveManagedSession = async (target: NativeSessionTarget, signal: AbortSignal): Promise<void> => {
        v.parse(
            v.object({ target: nativeSessionTargetSchema }),
            await this.#request(
                chatCalls.archiveManagedSession({
                    origin: this.#origin,
                    computerId: this.#computerId,
                    target: v.parse(nativeSessionTargetSchema, target),
                }),
                signal,
            ),
        );
    };
    readonly managedSession = async (target: NativeSessionTarget, signal: AbortSignal) => {
        const stored = v.parse(
            managedSdkSessionSchema,
            await this.#request(
                chatCalls.managedSession({
                    origin: this.#origin,
                    computerId: this.#computerId,
                    target: v.parse(nativeSessionTargetSchema, target),
                }),
                signal,
            ),
        );
        const ready = decodeSessionReadyEvent(JSON.stringify(stored.ready));
        if (ready.harness !== target.harness || stored.entry.sessionId !== target.sessionId) {
            throw new CloudApiError("INVALID_SESSION", "The saved Chat session is invalid.");
        }
        return {
            harness: stored.harness,
            entry: stored.entry,
            result: {
                action: "managed" as const,
                target: ready.target,
                ready,
            },
        };
    };
    /** Imports the native session a setup handoff names into the caller's Computer. */
    readonly continueNativeSession = async (harness: string, sessionId: string, signal: AbortSignal) =>
        continuedSession(
            await this.#request(
                chatCalls.continueNativeSession({
                    origin: this.#origin,
                    computerId: this.#computerId,
                    harness,
                    sessionId,
                }),
                signal,
            ),
        );
    /** The settings a new Session of the Agent starts with in the directory. */
    readonly agentSettings = async (
        harness: string,
        workspaceRef: string,
        signal: AbortSignal,
    ): Promise<AgentSettingsResult> => {
        signal.throwIfAborted();
        const requestedHarness = v.parse(identifier, harness);
        const result = v.parse(
            v.object({ settings: v.unknown() }),
            await this.#request(
                chatCalls.agentSettings({
                    origin: this.#origin,
                    computerId: this.#computerId,
                    harness: requestedHarness,
                    workspaceRef,
                }),
                signal,
            ),
        );
        const discovered = decodeAgentSettingsDiscoveredEvent(JSON.stringify(result.settings));
        const settings = {
            catalog: {
                harness: discovered.harness,
                agentVersion: discovered.agentVersion,
                observedAt: new Date().toISOString(),
                revision: discovered.settingsRevision,
                requestId: discovered.requestId,
                models: modelSelections(
                    discovered.settings.map((setting) => ({ ...setting, currentValue: setting.defaultValue })),
                ),
            },
            options: discovered.settings.map(({ defaultValue, ...setting }) => ({
                ...setting,
                currentValue:
                    setting.type === "select" && !setting.values.some((value) => value.value === defaultValue)
                        ? (setting.values[0]?.value ?? "")
                        : defaultValue,
            })),
        };
        return settings;
    };
    readonly computerConfiguration = async (parent: AbortSignal): Promise<BotComputerConfiguration> =>
        v.parse(
            computerConfigurationSchema,
            await this.#request(
                chatCalls.computerConfiguration({ origin: this.#origin, computerId: this.#computerId }),
                parent,
            ),
        );
    readonly directory = async (directory: string, signal: AbortSignal) =>
        decodeWorkspaceEntriesEvent(
            JSON.stringify(
                await this.#request(
                    chatCalls.directory({ origin: this.#origin, computerId: this.#computerId, directory }),
                    signal,
                ),
            ),
        );
    /** Resolves once the watched resource differs from the snapshot this client last read, or from its first sample. */
    readonly #waitForResourceChange = async (
        request: ApiRequest,
        parent: AbortSignal,
        onReady?: (snapshot: ApiResponseSnapshot) => void,
    ) => {
        const signal = AbortSignal.any([parent, AbortSignal.timeout(10 * 60 * 1000)]);
        const token = await this.#getToken(signal);
        if (token === null) {
            throw new CloudApiError("UNAUTHENTICATED", "Your session is unavailable.");
        }
        await this.#waitForChange({ ...request, headers: { authorization: `Bearer ${token}` }, signal }, onReady);
    };
    /** Resolves once the Computer's pairing differs from the pairing this client last read. */
    readonly waitForComputerPairingChange = async (parent: AbortSignal): Promise<void> =>
        await this.#waitForResourceChange(
            managementCalls.readComputerPairing({ origin: this.#origin, computerId: this.#computerId }),
            parent,
        );
    readonly waitForComputerConfigurationChange = async (
        parent: AbortSignal,
        onReady?: (configuration: BotComputerConfiguration) => void,
    ): Promise<void> =>
        await this.#waitForResourceChange(
            chatCalls.computerConfiguration({ origin: this.#origin, computerId: this.#computerId }),
            parent,
            onReady === undefined
                ? undefined
                : (snapshot) => {
                      const value = this.#readResponse(snapshot, parent);
                      onReady(v.parse(computerConfigurationSchema, value));
                  },
        );
    readonly forkNativeSession = async (
        operationId: string,
        input: ForkMortyNativeSessionRequest,
        signal: AbortSignal,
    ) => {
        const result = decodeNativeSessionResult(
            JSON.stringify(
                await this.#request(
                    chatCalls.forkNativeSession({
                        origin: this.#origin,
                        computerId: this.#computerId,
                        operationId,
                        input,
                    }),
                    signal,
                ),
            ),
        );
        if (
            result.action !== "fork" ||
            !sameNativeSession(result.ready.target, result.target) ||
            result.target.harness !== input.harness ||
            result.target.sessionId === input.sessionId
        ) {
            throw new CloudApiError("INVALID_SESSION", "The Computer returned an invalid fork.");
        }
        return result;
    };

    readonly nativeSessions = async (
        input:
            | Omit<Extract<NativeSessionRequest, { readonly action: "list" }>, "kind" | "requestId">
            | (Omit<
                  Extract<NativeSessionRequest, { readonly action: "import" | "fork" }>,
                  "kind" | "requestId" | "action"
              > & { readonly action: "import" }),
        signal: AbortSignal,
    ) => {
        if (input.action === "list") {
            return decodeNativeSessionResult(
                JSON.stringify(
                    await this.#request(
                        chatCalls.nativeSessions({ origin: this.#origin, computerId: this.#computerId, input }),
                        signal,
                    ),
                ),
            );
        }
        if (input.action !== "import") {
            throw new CloudApiError(
                "INVALID_REQUEST",
                "Fork through forkNativeSession and read local history through the session preview endpoint.",
            );
        }
        const { sessionId, ...identity } = input;
        return decodeNativeSessionResult(
            JSON.stringify(
                await this.#request(
                    chatCalls.importNativeSession({
                        origin: this.#origin,
                        computerId: this.#computerId,
                        sessionId: v.parse(identifier, sessionId),
                        identity,
                    }),
                    signal,
                ),
            ),
        );
    };
    readonly nativeSession = async (
        input: {
            readonly harness: string;
            readonly directory: string;
            readonly sessionId: string;
        },
        signal: AbortSignal,
    ) => {
        const { sessionId, ...identity } = input;
        return decodeNativeSessionEvents(
            await this.#request(
                chatCalls.nativeSession({
                    origin: this.#origin,
                    computerId: this.#computerId,
                    sessionId: v.parse(identifier, sessionId),
                    identity,
                }),
                signal,
            ),
        );
    };

    readonly connectSession = async (
        target: NativeSessionTarget,
        signal: AbortSignal,
        initialAccess?: ChatAccess,
    ): Promise<MortyClient> => {
        signal = AbortSignal.any([signal, this.#lifetime.signal]);
        signal.throwIfAborted();
        const readAccess = async (parent: AbortSignal) => {
            for (let attempt = 0; attempt < 2; attempt += 1) {
                try {
                    return v.parse(
                        sessionAccessSchema,
                        await this.#request(
                            chatCalls.sessionAccess({
                                origin: this.#origin,
                                computerId: this.#computerId,
                                target: v.parse(nativeSessionTargetSchema, target),
                            }),
                            parent,
                        ),
                    );
                } catch (cause) {
                    parent.throwIfAborted();
                    if (!(cause instanceof CloudApiError) || cause.code !== "CHAT_UNAVAILABLE" || attempt === 1) {
                        throw cause;
                    }
                }
            }
            throw new CloudApiError("CHAT_UNAVAILABLE", "Chat is unavailable.");
        };
        let access = initialAccess ?? (await readAccess(signal));
        const computerId = access.computerId;
        if (computerId !== this.#computerId || !sameNativeSession(access.target, target)) {
            throw new CloudApiError("INVALID_SESSION_ACCESS", "The selected Session could not be verified.");
        }
        signal.throwIfAborted();
        const client = new MortyClient({
            endpoint: this.#origin,
            computerId,
            transport: this.#sessionTransport(),
            operationTimeoutMilliseconds: 120000,
            onClose: () => {
                this.#sessionClients.delete(client);
            },
            observeResponse: ({ status }) =>
                recordBrowserDiagnostic({
                    at: new Date().toISOString(),
                    component: "relay",
                    operation: "session-request",
                    requestId: "",
                    elapsedMs: 0,
                    outcome: String(status),
                }),
            credentialProvider: {
                credential: async (parent) => {
                    if (Date.parse(access.expiresAt) - Date.now() < 30000) {
                        access = await readAccess(parent);
                    }
                    if (access.computerId !== computerId || !sameNativeSession(access.target, target)) {
                        throw new CloudApiError("INVALID_SESSION_ACCESS", "The selected Session changed.");
                    }
                    return access.credential;
                },
            },
        });
        this.#sessionClients.add(client);
        return client;
    };
    readonly #request = async (request: ApiRequest, parent: AbortSignal): Promise<unknown> => {
        const signal = AbortSignal.any([parent, AbortSignal.timeout(request.endpoint.timeoutMilliseconds)]);
        const token = await this.#getToken(signal);
        if (token === null) {
            throw new CloudApiError("UNAUTHENTICATED", "Your session is unavailable.");
        }
        const send = (access: string) =>
            this.#fetchRequest({
                ...request,
                signal,
                redirect: "error",
                headers: {
                    authorization: `Bearer ${access}`,
                    "content-type": "application/json",
                },
            });
        let response = await send(token);
        if (response.status === 401 && this.#replacedToken !== undefined) {
            const replacement = await this.#replacedToken(token, signal);
            if (replacement !== null) {
                await response.body?.cancel();
                response = await send(replacement);
            }
        }
        if (response.status === 401) {
            this.#credentialRejected?.();
        }
        let responseBody: string;
        try {
            responseBody = await response.text();
        } catch {
            signal.throwIfAborted();
            throw new CloudApiError("CHAT_UNAVAILABLE", "Chat returned an invalid response.");
        }
        return this.#readResponse({ status: response.status, headers: response.headers, body: responseBody }, signal);
    };
    readonly #readResponse = (response: ApiResponseSnapshot, signal: AbortSignal): unknown => {
        signal.throwIfAborted();
        let value: unknown;
        try {
            value = JSON.parse(response.body);
        } catch {
            signal.throwIfAborted();
            throw new CloudApiError("CHAT_UNAVAILABLE", "Chat returned an invalid response.");
        }
        signal.throwIfAborted();
        if (response.status < 200 || response.status >= 300) {
            const parsed = v.safeParse(v.object({ error: v.object({ code: v.string(), message: v.string() }) }), value);
            throw new CloudApiError(
                parsed.success ? parsed.output.error.code : "CHAT_UNAVAILABLE",
                parsed.success ? parsed.output.error.message : "Chat is unavailable.",
                response.status,
                response.headers.get("x-morty-request-id") ?? response.headers.get("x-request-id") ?? "",
            );
        }
        return value;
    };
}
