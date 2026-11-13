import type { ComputerEncryptionAccess, ForkMortyNativeSessionRequest } from "@morty-build/client";
import { MortyClient, type WsTransport } from "@morty-build/client";
import { sameNativeSession } from "@morty-build/client/native-session";
import type { NativeSessionRequest } from "@morty-build/client/protocol";
import {
    type AgentSetting,
    agentSettingsDiscoverCommandCodec,
    agentSettingsDiscoveredEventCodec,
    agentSettingsDiscoveryFailedEventCodec,
    computerDiagnosticsRequestCodec,
    computerDiagnosticsResultCodec,
    computerPingCommandCodec,
    computerPongEventCodec,
    decodeAgentSettingsDiscoverCommand,
    decodeComputerDiagnosticsRequest,
    decodeNativeSessionEvents,
    decodeNativeSessionRequest,
    decodeSessionAccessCredential,
    decodeSessionArchiveCommand,
    decodeSessionCreateCommand,
    decodeSessionListCommand,
    decodeSessionPrepareCommand,
    decodeSessionPreviewHistoryPageLoad,
    decodeSessionReadyEvent,
    decodeSessionRestoreCommand,
    decodeWorkspaceListCommand,
    type Identifier,
    isDirectoryPath,
    isIdentifier,
    type NativeSessionTarget,
    nativeSessionCommandCodec,
    nativeSessionResultCodec,
    type SessionConfigOption,
    type SessionConfigurationSelection,
    sessionArchiveCommandCodec,
    sessionArchivedEventCodec,
    sessionCreateCommandCodec,
    sessionListCommandCodec,
    sessionOperationFailedEventCodec,
    sessionPrepareCommandCodec,
    sessionPreviewHistoryPageLoadCodec,
    sessionPreviewHistoryPageLoadedCodec,
    sessionReadyEventCodec,
    sessionRestoreCommandCodec,
    sessionRestoredEventCodec,
    sessionsListedEventCodec,
    workspaceEntriesEventCodec,
    workspaceListCommandCodec,
} from "@morty-build/client/protocol";
import * as v from "valibot";
import type { ApiResponseSnapshot, ApiTransport } from "../api/api-transport.ts";
import type { ApiRequest } from "../api/calls/call.ts";
import { chatCalls } from "../api/calls/chat.ts";
import { managementCalls } from "../api/calls/management.ts";
import { recordBrowserDiagnostic } from "../diagnostics/browser-diagnostics.ts";
import type { AgentModelCatalog } from "../diagnostics/model-catalog.ts";
import { storedComputerEncryption } from "../identity/remembered-computers.ts";
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
/** The draft's option for an Agent's setting: a boolean holds its default flag, a select its default value when offered. */
function optionFromSetting(setting: AgentSetting): SessionConfigOption {
    const { category, description, id, name } = setting;
    if (setting.type === "boolean") {
        return { booleanValue: setting.booleanValue, category, description, id, name, type: "boolean" };
    }
    const offered = setting.values.some((value) => value.value === setting.defaultValue);
    return {
        category,
        currentValue: offered ? setting.defaultValue : (setting.values[0]?.value ?? ""),
        description,
        id,
        name,
        type: "select",
        values: setting.values,
    };
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
    readonly #encryptionAccess: () => ComputerEncryptionAccess | null;
    readonly #lifetime = new AbortController();
    readonly #waitForChange: ApiTransport["waitForChange"];
    readonly readComputerPairing: ManagementApi["readComputerPairing"];
    constructor(options: {
        readonly fetchRequest: ApiTransport["fetch"];
        /** Borrow the application's Computer connection; this API owns only its Session clients. */
        readonly sessionTransport: () => WsTransport;
        readonly encryptionAccess?: () => ComputerEncryptionAccess | null;
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
        this.#encryptionAccess = options.encryptionAccess ?? (() => storedComputerEncryption(this.#computerId));
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
    readonly daemonDiagnostics = async (signal: AbortSignal) => {
        if (this.#encryptionAccess() === null) {
            // An unpaired Computer has no encryption access yet; report the Worker's authoritative pairing failure.
            await this.computerConfiguration(signal);
        }
        const request = chatCalls.daemonDiagnostics({ origin: this.#origin, computerId: this.#computerId });
        const command = decodeComputerDiagnosticsRequest(request.body ?? "");
        const encryption = this.#sessionTransport().payloadEncryption;
        const body = await computerDiagnosticsRequestCodec.encode(command, encryption, signal);
        const value = await this.#request({ ...request, body }, signal);
        const result = await computerDiagnosticsResultCodec.decode(JSON.stringify(value), encryption, signal);
        if (result.requestId !== command.requestId) {
            throw new CloudApiError("INVALID_SESSION", "The Computer returned an invalid diagnostics response.");
        }
        return result;
    };
    readonly networkDiagnostic = async (signal: AbortSignal) => {
        const request = chatCalls.networkDiagnostic({ origin: this.#origin, computerId: this.#computerId });
        const command = v.parse(
            v.object({ kind: v.literal("computer.ping"), requestId: identifier }),
            JSON.parse(request.body ?? ""),
        );
        const encryption = this.#sessionTransport().payloadEncryption;
        const body = await computerPingCommandCodec.encode(command, encryption, signal);
        const result = v.parse(
            v.object({ computerLatencyMs: v.pipe(v.number(), v.safeInteger(), v.minValue(0)), reply: v.unknown() }),
            await this.#request({ ...request, body }, signal),
        );
        const pong = await computerPongEventCodec.decode(JSON.stringify(result.reply), encryption, signal);
        if (pong.requestId !== command.requestId) {
            throw new CloudApiError("INVALID_SESSION", "The Computer returned an invalid network response.");
        }
        return v.parse(networkDiagnosticSchema, { computerLatencyMs: result.computerLatencyMs });
    };
    readonly verifyAgent = async (harness: string, signal: AbortSignal): Promise<void> => {
        await this.#discoverAgentSettings(
            chatCalls.verifyAgent({ origin: this.#origin, computerId: this.#computerId, harness }),
            harness,
            signal,
        );
    };
    readonly #discoverAgentSettings = async (request: ApiRequest, harness: string, signal: AbortSignal) => {
        const command = decodeAgentSettingsDiscoverCommand(request.body ?? "");
        const encryption = this.#sessionTransport().payloadEncryption;
        const body = await agentSettingsDiscoverCommandCodec.encode(command, encryption, signal);
        const value = await this.#request({ ...request, body }, signal);
        const kind = v.parse(v.object({ kind: v.string() }), value).kind;
        const encoded = JSON.stringify(value);
        if (kind === "agent.settings.discovery.failed") {
            const failure = await agentSettingsDiscoveryFailedEventCodec.decode(encoded, encryption, signal);
            if (failure.requestId !== command.requestId) {
                throw new CloudApiError("INVALID_SESSION", "The Computer returned an invalid Agent response.");
            }
            throw new CloudApiError(failure.code, failure.message);
        }
        const discovered = await agentSettingsDiscoveredEventCodec.decode(encoded, encryption, signal);
        if (discovered.requestId !== command.requestId || discovered.harness !== harness) {
            throw new CloudApiError("INVALID_SESSION", "The Computer returned an invalid Agent response.");
        }
        return discovered;
    };
    readonly createConversation = async (
        conversationKey: string,
        settings: ChatDraftConfiguration,
        signal: AbortSignal,
    ): Promise<ChatAccess> => {
        const digest = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(JSON.stringify([this.#computerId, "create", conversationKey])),
        );
        signal.throwIfAborted();
        const operationId = `create_${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
        const request = chatCalls.createConversation({
            origin: this.#origin,
            computerId: this.#computerId,
            input: {
                harness: settings.harness,
                configurations: settings.configurations,
                operationId,
                workspaceRef: settings.workspaceRef,
            },
        });
        const command = decodeSessionCreateCommand(request.body ?? "");
        const encryption = this.#sessionTransport().payloadEncryption;
        const body = await sessionCreateCommandCodec.encode(command, encryption, signal);
        const result = await this.#request({ ...request, body }, signal);
        const encoded = JSON.stringify(result);
        if (v.safeParse(v.object({ kind: v.literal("session.operation.failed") }), result).success) {
            const failure = await sessionOperationFailedEventCodec.decode(encoded, encryption, signal);
            if (failure.requestId !== command.requestId) {
                throw new CloudApiError("INVALID_SESSION", "The Computer returned an invalid Session response.");
            }
            throw new CloudApiError(failure.code, failure.message);
        }
        const access = v.parse(accessSchema, {
            ...v.parse(v.looseObject({ ready: v.unknown() }), result),
            workspaceRef: settings.workspaceRef,
        });
        const ready = await sessionReadyEventCodec.decode(JSON.stringify(access.ready), encryption, signal);
        if (
            ready.requestId !== command.requestId ||
            ready.harness !== settings.harness ||
            ready.target.harness !== settings.harness ||
            access.harness !== ready.harness ||
            access.computerId !== this.#computerId ||
            !sameNativeSession(access.target, ready.target)
        ) {
            throw new CloudApiError("INVALID_SESSION", "The Computer returned an invalid Session response.");
        }
        return { ...access, ready };
    };
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
    readonly managedSessions = async (signal: AbortSignal) => {
        const request = chatCalls.managedSessions({ origin: this.#origin, computerId: this.#computerId });
        const command = decodeSessionListCommand(request.body ?? "");
        const encryption = this.#sessionTransport().payloadEncryption;
        const body = await sessionListCommandCodec.encode(command, encryption, signal);
        const value = await this.#request({ ...request, body }, signal);
        const encoded = JSON.stringify(value);
        if (v.safeParse(v.object({ kind: v.literal("session.operation.failed") }), value).success) {
            const failure = await sessionOperationFailedEventCodec.decode(encoded, encryption, signal);
            if (failure.requestId !== command.requestId) {
                throw new CloudApiError("INVALID_SESSION", "The Computer returned an invalid Session response.");
            }
            throw new CloudApiError(failure.code, failure.message);
        }
        const listed = await sessionsListedEventCodec.decode(encoded, encryption, signal);
        if (listed.requestId !== command.requestId) {
            throw new CloudApiError("INVALID_SESSION", "The Computer returned an invalid Session response.");
        }
        return v.parse(
            v.array(managedSessionSchema),
            listed.entries.map(({ directory, directoryLabel, prompted, target, status, title, updatedAt }) => ({
                directory,
                directoryLabel,
                prompted,
                target,
                status,
                title,
                updatedAt,
            })),
        );
    };
    /** Resolves once the Computer no longer holds the Session; otherwise rejects with the Computer's failure. */
    readonly archiveManagedSession = async (target: NativeSessionTarget, signal: AbortSignal): Promise<void> => {
        const request = chatCalls.archiveManagedSession({
            origin: this.#origin,
            computerId: this.#computerId,
            target: v.parse(nativeSessionTargetSchema, target),
        });
        const command = decodeSessionArchiveCommand(request.body ?? "");
        const encryption = this.#sessionTransport().payloadEncryption;
        const body = await sessionArchiveCommandCodec.encode(command, encryption, signal);
        const value = await this.#request({ ...request, body }, signal);
        const encoded = JSON.stringify(value);
        if (v.safeParse(v.object({ kind: v.literal("session.operation.failed") }), value).success) {
            const failure = await sessionOperationFailedEventCodec.decode(encoded, encryption, signal);
            if (
                failure.requestId !== command.requestId ||
                (failure.target !== undefined && !sameNativeSession(failure.target, target))
            ) {
                throw new CloudApiError("INVALID_SESSION", "The Computer returned an invalid Session response.");
            }
            throw new CloudApiError(failure.code, failure.message);
        }
        const archived = await sessionArchivedEventCodec.decode(encoded, encryption, signal);
        if (archived.requestId !== command.requestId || !sameNativeSession(archived.target, target)) {
            throw new CloudApiError("INVALID_SESSION", "The Computer returned an invalid Session response.");
        }
    };
    readonly managedSession = async (target: NativeSessionTarget, signal: AbortSignal) => {
        const request = chatCalls.managedSession({
            origin: this.#origin,
            computerId: this.#computerId,
            target: v.parse(nativeSessionTargetSchema, target),
        });
        const command = decodeSessionRestoreCommand(request.body ?? "");
        const encryption = this.#sessionTransport().payloadEncryption;
        const body = await sessionRestoreCommandCodec.encode(command, encryption, signal);
        const value = await this.#request({ ...request, body }, signal);
        const encoded = JSON.stringify(value);
        if (v.safeParse(v.object({ kind: v.literal("session.operation.failed") }), value).success) {
            const failure = await sessionOperationFailedEventCodec.decode(encoded, encryption, signal);
            if (
                failure.requestId !== command.requestId ||
                (failure.target !== undefined && !sameNativeSession(failure.target, target))
            ) {
                throw new CloudApiError("INVALID_SESSION", "The Computer returned an invalid Session response.");
            }
            if (failure.code === "session_not_found") {
                throw new CloudApiError(
                    "NOT_FOUND",
                    'This session is not in Morty Recent sessions. If you closed it in Morty, use "Open Session" to import or fork it again.',
                );
            }
            throw new CloudApiError(failure.code, failure.message);
        }
        const restored = await sessionRestoredEventCodec.decode(encoded, encryption, signal);
        const ready = restored.ready;
        if (
            restored.requestId !== command.requestId ||
            !sameNativeSession(restored.target, target) ||
            !sameNativeSession(ready.target, target) ||
            ready.harness !== target.harness ||
            restored.entry.sessionId !== target.sessionId
        ) {
            throw new CloudApiError("INVALID_SESSION", "The saved Chat session is invalid.");
        }
        return {
            harness: restored.entry.harness,
            entry: {
                sessionId: restored.entry.sessionId,
                title: restored.entry.title,
                directory: ready.directory,
                directoryLabel: ready.directoryLabel,
                updatedAt: restored.entry.updatedAt,
            },
            result: {
                action: "managed" as const,
                target: ready.target,
                ready,
            },
        };
    };
    /** Imports the native session a setup handoff names into the caller's Computer. */
    readonly continueNativeSession = async (harness: string, sessionId: string, signal: AbortSignal) => {
        const find = await this.#nativeSessionResult(
            chatCalls.continueNativeSession({
                origin: this.#origin,
                computerId: this.#computerId,
                harness,
                sessionId,
                action: "find",
                directory: ".",
            }),
            signal,
        );
        if (find.action !== "find" || find.entry.sessionId !== sessionId) {
            throw new CloudApiError("INVALID_SESSION", "The Computer returned an invalid Session lookup.");
        }
        const result = await this.#nativeSessionResult(
            chatCalls.continueNativeSession({
                origin: this.#origin,
                computerId: this.#computerId,
                harness,
                sessionId,
                action: "import",
                directory: find.entry.directory,
            }),
            signal,
        );
        if (result.action !== "import" || result.target.harness !== harness || result.target.sessionId !== sessionId) {
            throw new CloudApiError("INVALID_SESSION", "The Computer returned an invalid Session import.");
        }
        return { harness, result, entry: find.entry };
    };
    /** The settings a new Session of the Agent starts with in the directory. */
    readonly agentSettings = async (
        harness: string,
        workspaceRef: string,
        signal: AbortSignal,
    ): Promise<AgentSettingsResult> => {
        signal.throwIfAborted();
        const requestedHarness = v.parse(identifier, harness);
        const discovered = await this.#discoverAgentSettings(
            chatCalls.agentSettings({
                origin: this.#origin,
                computerId: this.#computerId,
                harness: requestedHarness,
                workspaceRef,
            }),
            requestedHarness,
            signal,
        );
        const settings = {
            catalog: {
                harness: discovered.harness,
                agentVersion: discovered.agentVersion,
                observedAt: new Date().toISOString(),
                revision: discovered.settingsRevision,
                requestId: discovered.requestId,
                models: discovered.settings.flatMap((setting) =>
                    setting.category === "model" && setting.type === "select"
                        ? [{ selected: setting.defaultValue, values: setting.values.map((value) => value.value) }]
                        : [],
                ),
            },
            options: discovered.settings.map(optionFromSetting),
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
    readonly directory = async (directory: string, signal: AbortSignal) => {
        const request = chatCalls.directory({ origin: this.#origin, computerId: this.#computerId, directory });
        const command = decodeWorkspaceListCommand(request.body ?? "");
        const encryption = this.#sessionTransport().payloadEncryption;
        const body = await workspaceListCommandCodec.encode(command, encryption, signal);
        const value = await this.#request({ ...request, body }, signal);
        const encoded = JSON.stringify(value);
        if (v.safeParse(v.object({ kind: v.literal("session.operation.failed") }), value).success) {
            const failure = await sessionOperationFailedEventCodec.decode(encoded, encryption, signal);
            if (failure.requestId !== command.requestId) {
                throw new CloudApiError("INVALID_SESSION", "The Computer returned an invalid directory response.");
            }
            throw new CloudApiError(failure.code, failure.message);
        }
        const entries = await workspaceEntriesEventCodec.decode(encoded, encryption, signal);
        if (entries.requestId !== command.requestId) {
            throw new CloudApiError("INVALID_SESSION", "The Computer returned an invalid directory response.");
        }
        return entries;
    };
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
        const digest = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(`${this.#computerId}\u0000fork\u0000${operationId}`),
        );
        signal.throwIfAborted();
        const requestId = `chat_${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
        const result = await this.#nativeSessionResult(
            chatCalls.forkNativeSession({
                origin: this.#origin,
                computerId: this.#computerId,
                operationId,
                requestId,
                input,
            }),
            signal,
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
            const result = await this.#nativeSessionResult(
                chatCalls.nativeSessions({ origin: this.#origin, computerId: this.#computerId, input }),
                signal,
            );
            if (result.action !== "list") {
                throw new CloudApiError("INVALID_SESSION", "The Computer returned an invalid Session directory.");
            }
            return result;
        }
        if (input.action !== "import") {
            throw new CloudApiError(
                "INVALID_REQUEST",
                "Fork through forkNativeSession and read local history through the session preview endpoint.",
            );
        }
        const { sessionId, ...identity } = input;
        const result = await this.#nativeSessionResult(
            chatCalls.importNativeSession({
                origin: this.#origin,
                computerId: this.#computerId,
                sessionId: v.parse(identifier, sessionId),
                identity,
            }),
            signal,
        );
        if (
            result.action !== "import" ||
            result.target.harness !== identity.harness ||
            result.target.sessionId !== sessionId
        ) {
            throw new CloudApiError("INVALID_SESSION", "The Computer returned an invalid Session import.");
        }
        return result;
    };
    readonly #nativeSessionResult = async (request: ApiRequest, signal: AbortSignal) => {
        const command = decodeNativeSessionRequest(request.body ?? "");
        const encryption = this.#sessionTransport().payloadEncryption;
        const body = await nativeSessionCommandCodec.encode(command, encryption, signal);
        const value = await this.#request({ ...request, body }, signal);
        const encoded = JSON.stringify(value);
        if (v.safeParse(v.object({ kind: v.literal("session.operation.failed") }), value).success) {
            const failure = await sessionOperationFailedEventCodec.decode(encoded, encryption, signal);
            if (failure.requestId !== command.requestId) {
                throw new CloudApiError("INVALID_SESSION", "The Computer returned an invalid Session response.");
            }
            throw new CloudApiError(failure.code, failure.message);
        }
        const result = await nativeSessionResultCodec.decode(encoded, encryption, signal);
        if (result.requestId !== command.requestId) {
            throw new CloudApiError("INVALID_SESSION", "The Computer returned an invalid Session response.");
        }
        return result;
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
        const request = chatCalls.nativeSession({
            origin: this.#origin,
            computerId: this.#computerId,
            sessionId: v.parse(identifier, sessionId),
            identity,
        });
        const command = decodeSessionPreviewHistoryPageLoad(request.body ?? "");
        const encryption = this.#sessionTransport().payloadEncryption;
        const body = await sessionPreviewHistoryPageLoadCodec.encode(command, encryption, signal);
        const value = await this.#request({ ...request, body }, signal);
        const encoded = JSON.stringify(value);
        if (v.safeParse(v.object({ kind: v.literal("session.operation.failed") }), value).success) {
            const failure = await sessionOperationFailedEventCodec.decode(encoded, encryption, signal);
            if (
                failure.requestId !== command.requestId ||
                (failure.target !== undefined && !sameNativeSession(failure.target, command.target))
            ) {
                throw new CloudApiError("INVALID_SESSION", "The Computer returned an invalid Session preview.");
            }
            throw new CloudApiError(failure.code, failure.message);
        }
        const result = await sessionPreviewHistoryPageLoadedCodec.decode(encoded, encryption, signal);
        if (result.requestId !== command.requestId || !sameNativeSession(result.target, command.target)) {
            throw new CloudApiError("INVALID_SESSION", "The Computer returned an invalid Session preview.");
        }
        return decodeNativeSessionEvents(result.events);
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
                    const request = chatCalls.sessionAccess({
                        origin: this.#origin,
                        computerId: this.#computerId,
                        target: v.parse(nativeSessionTargetSchema, target),
                    });
                    const command = decodeSessionPrepareCommand(request.body ?? "");
                    const encryption = this.#sessionTransport().payloadEncryption;
                    const body = await sessionPrepareCommandCodec.encode(command, encryption, parent);
                    const value = await this.#request({ ...request, body }, parent);
                    if (v.safeParse(v.object({ kind: v.literal("session.operation.failed") }), value).success) {
                        const failure = await sessionOperationFailedEventCodec.decode(
                            JSON.stringify(value),
                            encryption,
                            parent,
                        );
                        if (
                            failure.requestId !== command.requestId ||
                            (failure.target !== undefined && !sameNativeSession(failure.target, target))
                        ) {
                            throw new CloudApiError(
                                "INVALID_SESSION_ACCESS",
                                "The selected Session could not be verified.",
                            );
                        }
                        throw new CloudApiError(failure.code, failure.message);
                    }
                    return v.parse(sessionAccessSchema, value);
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
        const encryptionAccess = this.#encryptionAccess();
        if (encryptionAccess === null || encryptionAccess.computerId !== computerId) {
            throw new CloudApiError("INVALID_SESSION_ACCESS", "Encrypted Computer access is unavailable.");
        }
        const client = new MortyClient({
            endpoint: this.#origin,
            computerId,
            transport: this.#sessionTransport(),
            encryption: { access: encryptionAccess },
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
