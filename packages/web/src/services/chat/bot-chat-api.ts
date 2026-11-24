import {
    type ComputerEncryptionAccess,
    MortyApiError,
    MortyClient,
    MortyComputerClient,
    type MortyCreatedSession,
    type MortyCredentialProvider,
    MortyOperationError,
    MortyProtocolError,
    type MortySessionAccess,
    MortyValidationError,
    type NativeSessionLocation,
    type WsTransport,
} from "@portalcrew/morty-client";
import { sameNativeSession } from "@portalcrew/morty-client/native-session";
import {
    type AgentSetting,
    type Identifier,
    isIdentifier,
    type NativeSessionTarget,
    type SessionConfigOption,
    type SessionConfigurationSelection,
    type SessionMetadata,
    type SessionRestoredEvent,
} from "@portalcrew/morty-client/protocol";
import * as v from "valibot";
import type { ApiResponseSnapshot, ApiTransport } from "../api/api-transport.ts";
import type { ApiRequest } from "../api/calls/call.ts";
import { chatCalls } from "../api/calls/chat.ts";
import { managementCalls } from "../api/calls/management.ts";
import {
    recordBrowserDiagnostic,
    recordLiveEventsObservation,
    recordRequestObservation,
} from "../diagnostics/browser-diagnostics.ts";
import type { AgentModelCatalog } from "../diagnostics/model-catalog.ts";
import { storedComputerEncryption } from "../identity/remembered-computers.ts";
import { ManagementApi } from "../management/management-api.ts";

const identifier = v.custom<Identifier>(isIdentifier);
export type ChatAccess = MortyCreatedSession & { readonly workspaceRef: string };
export type ManagedChatSession = SessionMetadata;
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
export function connectedChatComputerAgents(computer: ChatComputer | undefined): readonly ChatAgentSelection[] {
    return computer?.online ? computer.agents : [];
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
    readonly #credentials: MortyCredentialProvider;
    readonly #credentialRejected: (() => void) | undefined;
    readonly #sessionClients = new Set<MortyClient>();
    readonly #sessionTransport: () => WsTransport;
    readonly #encryptionAccess: () => ComputerEncryptionAccess | null;
    readonly #lifetime = new AbortController();
    readonly #waitForChange: ApiTransport["waitForChange"];
    readonly readComputerPairing: ManagementApi["readComputerPairing"];
    constructor(options: {
        readonly fetchRequest: ApiTransport["fetch"];
        readonly sessionTransport: () => WsTransport;
        readonly encryptionAccess?: () => ComputerEncryptionAccess | null;
        readonly origin: string;
        readonly computerId: string;
        readonly getToken: (signal: AbortSignal) => Promise<string | null>;
        readonly replacedToken?: (rejected: string, signal: AbortSignal) => Promise<string | null>;
        readonly credentialRejected?: () => void;
        readonly waitForChange: ApiTransport["waitForChange"];
    }) {
        this.#origin = v.parse(v.pipe(v.string(), v.url()), options.origin);
        this.#computerId = v.parse(identifier, options.computerId);
        this.#fetchRequest = options.fetchRequest;
        this.#sessionTransport = options.sessionTransport;
        this.#encryptionAccess = options.encryptionAccess ?? (() => storedComputerEncryption(this.#computerId));
        this.#credentials = {
            credential: async (signal) => {
                const token = await options.getToken(signal);
                if (token === null) {
                    throw new MortyApiError("UNAUTHENTICATED", "Your session is unavailable.", 401);
                }
                return token;
            },
            ...(options.replacedToken === undefined ? {} : { replacement: options.replacedToken }),
        };
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
    readonly #computer = (): MortyComputerClient =>
        new MortyComputerClient({
            endpoint: this.#origin,
            computerId: this.#computerId,
            transport: this.#sessionTransport(),
            credentialProvider: this.#credentials,
            observeRequest: (observation) => {
                recordRequestObservation("worker", observation);
                if (observation.outcome.kind === "answered" && observation.outcome.status === 401) {
                    this.#credentialRejected?.();
                }
            },
        });
    readonly daemonDiagnostics = async (signal: AbortSignal) => {
        if (this.#encryptionAccess() === null) {
            // An unpaired Computer has no encryption access yet; report the Worker's authoritative pairing failure.
            await this.computerConfiguration(signal);
        }
        return await this.#computer().readDiagnostics(signal);
    };
    readonly networkDiagnostic = async (signal: AbortSignal) => await this.#computer().measureLatency(signal);
    readonly updateComputer = async (version: string, signal: AbortSignal) =>
        await this.#computer().updateComputer(version, signal);
    readonly verifyAgent = async (harness: string, signal: AbortSignal): Promise<void> => {
        await this.#computer().verifyAgent(harness, signal);
    };
    readonly createConversation = async (
        conversationKey: string,
        settings: ChatDraftConfiguration,
        signal: AbortSignal,
    ): Promise<ChatAccess> => {
        const created = await this.#computer().createSession(
            {
                conversationKey,
                harness: settings.harness,
                directory: settings.workspaceRef,
                configurations: settings.configurations,
            },
            signal,
        );
        return { ...created, workspaceRef: settings.workspaceRef };
    };
    readonly conversationSession = (
        access: ChatAccess,
        directoryLabel = access.workspaceRef,
        title = "Untitled session",
    ) => {
        const { kind: _kind, requestId, target: _target, ...ready } = access.ready;
        return {
            target: access.target,
            requestId,
            ready,
            origin: { kind: "created" as const, access },
            entry: {
                title,
                directory: access.workspaceRef,
                directoryLabel,
                updatedAt: null,
            },
        };
    };
    readonly managedSessions = async (signal: AbortSignal): Promise<readonly ManagedChatSession[]> =>
        await this.#computer().listSessions(signal);
    readonly archiveManagedSession = async (target: NativeSessionTarget, signal: AbortSignal): Promise<void> =>
        await this.#computer().archiveSession(target, signal);
    readonly managedSession = async (target: NativeSessionTarget, signal: AbortSignal) => {
        let restored: SessionRestoredEvent;
        try {
            restored = await this.#computer().restoreSession(target, signal);
        } catch (cause) {
            if (cause instanceof MortyOperationError && cause.code === "session_not_found") {
                throw new MortyOperationError(
                    cause.code,
                    'This session is not in Morty Recent sessions. If you closed it in Morty, use "Open Session" to import or fork it again.',
                    { cause },
                );
            }
            throw cause;
        }
        return {
            target,
            requestId: restored.requestId,
            ready: restored.ready,
            origin: { kind: "opened" as const },
            entry: {
                title: restored.entry.title,
                directory: restored.ready.directory,
                directoryLabel: restored.ready.directoryLabel,
                updatedAt: restored.entry.updatedAt,
            },
        };
    };
    readonly continueNativeSession = async (harness: string, sessionId: string, signal: AbortSignal) => {
        const { entry, imported } = await this.#computer().continueNativeSession(harness, sessionId, signal);
        const { sessionId: _sessionId, ...listed } = entry;
        return {
            target: imported.target,
            requestId: imported.requestId,
            ready: imported.ready,
            origin: { kind: "opened" as const },
            entry: listed,
        };
    };
    readonly agentSettings = async (
        harness: string,
        workspaceRef: string,
        signal: AbortSignal,
    ): Promise<AgentSettingsResult> => {
        const discovered = await this.#computer().discoverAgentSettings(harness, workspaceRef, signal);
        return {
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
        await this.#computer().listDirectory(directory, signal);
    readonly #waitForResourceChange = async (
        request: ApiRequest,
        parent: AbortSignal,
        onReady?: (snapshot: ApiResponseSnapshot) => void,
    ) => {
        const signal = AbortSignal.any([parent, AbortSignal.timeout(10 * 60 * 1000)]);
        const token = await this.#credentials.credential(signal);
        await this.#waitForChange({ ...request, headers: { authorization: `Bearer ${token}` }, signal }, onReady);
    };
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
    readonly forkNativeSession = async (operationId: string, location: NativeSessionLocation, signal: AbortSignal) =>
        await this.#computer().forkNativeSession(operationId, location, signal);
    readonly nativeSessions = async (
        input: { readonly harness: string; readonly directory: string; readonly cursor: string | null },
        signal: AbortSignal,
    ) => await this.#computer().listNativeSessions(input, signal);
    readonly importNativeSession = async (location: NativeSessionLocation, signal: AbortSignal) =>
        await this.#computer().importNativeSession(location, signal);
    readonly nativeSession = async (location: NativeSessionLocation, signal: AbortSignal) =>
        await this.#computer().previewNativeSession(location, signal);

    readonly connectSession = async (
        target: NativeSessionTarget,
        signal: AbortSignal,
        initialAccess?: ChatAccess,
    ): Promise<MortyClient> => {
        signal = AbortSignal.any([signal, this.#lifetime.signal]);
        signal.throwIfAborted();
        const readAccess = async (parent: AbortSignal) => {
            try {
                return await this.#computer().prepareSession(target, parent);
            } catch (cause) {
                parent.throwIfAborted();
                if (!(cause instanceof MortyProtocolError)) {
                    throw cause;
                }
                // Issuing a credential changes nothing, so a reply the Worker garbled is read once more.
                return await this.#computer().prepareSession(target, parent);
            }
        };
        let access: MortySessionAccess = initialAccess ?? (await readAccess(signal));
        const computerId = access.computerId;
        if (computerId !== this.#computerId || !sameNativeSession(access.target, target)) {
            throw new MortyProtocolError("The selected Session could not be verified.");
        }
        signal.throwIfAborted();
        const encryptionAccess = this.#encryptionAccess();
        if (encryptionAccess === null || encryptionAccess.computerId !== computerId) {
            throw new MortyValidationError("Encrypted Computer access is unavailable.");
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
            observeRequest: (observation) => recordRequestObservation("relay", observation),
            observeLiveEvents: recordLiveEventsObservation,
            observeUnsupportedEntries: (entries) =>
                recordBrowserDiagnostic({
                    at: new Date().toISOString(),
                    component: "relay",
                    operation: "session-entries-skipped",
                    requestId: "",
                    elapsedMs: 0,
                    outcome: `${entries.length} ${entries.some((entry) => entry.reason === "malformed") ? "malformed" : "unknown"}`,
                }),
            credentialProvider: {
                credential: async (parent) => {
                    if (Date.parse(access.expiresAt) - Date.now() < 30000) {
                        access = await readAccess(parent);
                    }
                    if (access.computerId !== computerId || !sameNativeSession(access.target, target)) {
                        throw new MortyProtocolError("The selected Session changed.");
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
        const token = await this.#credentials.credential(signal);
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
        if (response.status === 401 && this.#credentials.replacement !== undefined) {
            const replacement = await this.#credentials.replacement(token, signal);
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
            throw new MortyApiError("service_unavailable", "Chat returned an invalid response.", response.status);
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
            throw new MortyApiError("service_unavailable", "Chat returned an invalid response.", response.status);
        }
        signal.throwIfAborted();
        if (response.status < 200 || response.status >= 300) {
            const parsed = v.safeParse(v.object({ error: v.object({ code: v.string(), message: v.string() }) }), value);
            throw new MortyApiError(
                parsed.success ? parsed.output.error.code : "service_unavailable",
                parsed.success ? parsed.output.error.message : "Chat is unavailable.",
                response.status,
                { requestId: response.headers.get("x-morty-request-id") ?? response.headers.get("x-request-id") ?? "" },
            );
        }
        return value;
    };
}
