import {
    AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
    type AgentSettingsDiscoveredEvent,
    agentSettingsDiscoverCommandCodec,
    agentSettingsDiscoveredEventCodec,
    agentSettingsDiscoveryFailedEventCodec,
    type ComputerDiagnosticsResult,
    type ComputerUpdateRestarting,
    computerDiagnosticsRequestCodec,
    computerDiagnosticsResultCodec,
    computerPingCommandCodec,
    computerPongEventCodec,
    computerUpdateRequestCodec,
    computerUpdateRestartingCodec,
    decodeMessageKind,
    decodeNativeSessionEvents,
    decodeSessionAccessCredential,
    type NativeSessionCommand,
    type NativeSessionEntry,
    type NativeSessionResult,
    type NativeSessionTarget,
    nativeSessionCommandCodec,
    nativeSessionResultCodec,
    type SessionConfigurationSelection,
    type SessionMetadata,
    type SessionReadyEvent,
    type SessionRestoredEvent,
    sessionArchiveCommandCodec,
    sessionArchivedEventCodec,
    sessionCreateCommandCodec,
    sessionListCommandCodec,
    sessionPrepareCommandCodec,
    sessionPreviewHistoryPageLoadCodec,
    sessionPreviewHistoryPageLoadedCodec,
    sessionReadyEventCodec,
    sessionRestoreCommandCodec,
    sessionRestoredEventCodec,
    sessionsListedEventCodec,
    type WorkspaceEntriesEvent,
    workspaceEntriesEventCodec,
    workspaceListCommandCodec,
} from "@portalcrew/morty-client/protocol";
import { z } from "zod";
import { computerEndpoints } from "./calls/computer.ts";
import { MortyOperationError, MortyProtocolError } from "./errors.ts";
import { nativeForkRequestId, nativeSessionTarget, sameNativeSession } from "./native-session.ts";
import { nativeSessionTargetSchema } from "./protocol/session/shared/native-session-target.ts";
import { type MortyEndpointOptions, MortyRequestExecutor } from "./service-client.ts";
import type { WsTransport } from "./transport/ws-transport.ts";

export interface MortyComputerClientOptions extends MortyEndpointOptions {
    readonly computerId: string;
    readonly transport: WsTransport;
}

export interface NativeSessionLocation {
    readonly harness: string;
    readonly sessionId: string;
    readonly directory: string;
}

export interface MortySessionAccess {
    readonly computerId: string;
    readonly credential: string;
    readonly expiresAt: string;
    readonly target: NativeSessionTarget;
}

export interface MortyCreatedSession extends MortySessionAccess {
    readonly ready: SessionReadyEvent;
}

type NativeSessionAnswer<Action extends NativeSessionResult["action"]> = Extract<
    NativeSessionResult,
    { readonly action: Action }
>;

const identifierText = z.string().min(1).max(128);
const sessionAccessReplySchema = z.object({
    computerId: identifierText,
    credential: z.string().refine((credential) => {
        try {
            decodeSessionAccessCredential(credential);
            return true;
        } catch {
            return false;
        }
    }, "Invalid Session credential"),
    expiresAt: z.iso.datetime({ offset: true }),
    target: nativeSessionTargetSchema,
});
const createdSessionReplySchema = sessionAccessReplySchema.extend({ ready: z.unknown() });
const pingReplySchema = z.object({ computerLatencyMs: z.number().int().nonnegative(), reply: z.unknown() });

function parseReply<Schema extends z.ZodType>(schema: Schema, encoded: string): z.infer<Schema> {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new MortyProtocolError("The service returned invalid JSON", { cause });
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
        throw new MortyProtocolError("The service returned an invalid reply", { cause: parsed.error });
    }
    return parsed.data;
}

function isNativeAnswer<Action extends NativeSessionResult["action"]>(
    result: NativeSessionResult,
    action: Action,
): result is NativeSessionAnswer<Action> {
    return result.action === action;
}

function nativeAnswer<Action extends NativeSessionResult["action"]>(action: Action) {
    return {
        decode: async (
            encoded: string,
            decryptor: Parameters<typeof nativeSessionResultCodec.decode>[1],
            signal: AbortSignal,
        ): Promise<NativeSessionAnswer<Action>> => {
            const result = await nativeSessionResultCodec.decode(encoded, decryptor, signal);
            if (!isNativeAnswer(result, action)) {
                throw new MortyProtocolError(`The Computer answered a ${action} request with ${result.action}.`);
            }
            return result;
        },
    };
}

export class MortyComputerClient {
    readonly #executor: MortyRequestExecutor;
    readonly #computerId: string;

    constructor(options: MortyComputerClientOptions) {
        this.#executor = new MortyRequestExecutor(options, options.transport);
        this.#computerId = options.computerId;
    }

    readonly close = (): void => this.#executor.close();

    readonly verifyAgent = async (harness: string, signal: AbortSignal): Promise<AgentSettingsDiscoveredEvent> =>
        await this.#discoverAgentSettings(
            computerEndpoints.verifyAgent({ computerId: this.#computerId }),
            harness,
            ".",
            signal,
        );

    readonly discoverAgentSettings = async (
        harness: string,
        directory: string,
        signal: AbortSignal,
    ): Promise<AgentSettingsDiscoveredEvent> =>
        await this.#discoverAgentSettings(
            computerEndpoints.discoverAgentSettings({ computerId: this.#computerId }),
            harness,
            directory,
            signal,
        );

    readonly #discoverAgentSettings = async (
        endpoint: ReturnType<typeof computerEndpoints.verifyAgent>,
        harness: string,
        directory: string,
        signal: AbortSignal,
    ): Promise<AgentSettingsDiscoveredEvent> => {
        const requestId = crypto.randomUUID();
        return await this.#executor.exchange(
            {
                endpoint,
                body: await agentSettingsDiscoverCommandCodec.encode(
                    { kind: "agent.settings.discover", requestId, harness, directory },
                    this.#executor.payloadEncryption,
                    signal,
                ),
                requestId,
                reply: {
                    decode: async (encoded, decryptor, replySignal) => {
                        if (decodeMessageKind(encoded) !== AGENT_SETTINGS_DISCOVERY_FAILED_KIND) {
                            return await agentSettingsDiscoveredEventCodec.decode(encoded, decryptor, replySignal);
                        }
                        const failure = await agentSettingsDiscoveryFailedEventCodec.decode(
                            encoded,
                            decryptor,
                            replySignal,
                        );
                        if (failure.requestId !== requestId) {
                            throw new MortyProtocolError("The Computer returned a failure for another request");
                        }
                        throw new MortyOperationError(failure.code, failure.message, { cause: failure });
                    },
                },
                mismatch: "The Computer returned an invalid Agent response.",
                isAnswer: (reply) => reply.harness === harness,
            },
            signal,
        );
    };

    readonly readDiagnostics = async (signal: AbortSignal): Promise<ComputerDiagnosticsResult> => {
        const requestId = crypto.randomUUID();
        return await this.#executor.exchange(
            {
                endpoint: computerEndpoints.readDiagnostics({ computerId: this.#computerId }),
                body: await computerDiagnosticsRequestCodec.encode(
                    { kind: "computer.diagnostics.read", requestId },
                    this.#executor.payloadEncryption,
                    signal,
                ),
                requestId,
                reply: computerDiagnosticsResultCodec,
                mismatch: "The Computer returned an invalid diagnostics response.",
            },
            signal,
        );
    };

    /** Success means the Computer has handed over to its updater and is restarting into `version`. */
    readonly updateComputer = async (version: string, signal: AbortSignal): Promise<ComputerUpdateRestarting> => {
        const requestId = crypto.randomUUID();
        return await this.#executor.exchange(
            {
                endpoint: computerEndpoints.updateComputer({ computerId: this.#computerId }),
                body: await computerUpdateRequestCodec.encode(
                    { kind: "computer.update", requestId, version },
                    this.#executor.payloadEncryption,
                    signal,
                ),
                requestId,
                reply: computerUpdateRestartingCodec,
                mismatch: "The Computer returned an invalid update response.",
                isAnswer: (reply) => reply.version === version,
            },
            signal,
        );
    };

    readonly measureLatency = async (signal: AbortSignal): Promise<{ readonly computerLatencyMs: number }> => {
        const requestId = crypto.randomUUID();
        const { computerLatencyMs } = await this.#executor.exchange(
            {
                endpoint: computerEndpoints.measureLatency({ computerId: this.#computerId }),
                body: await computerPingCommandCodec.encode(
                    { kind: "computer.ping", requestId },
                    this.#executor.payloadEncryption,
                    signal,
                ),
                requestId,
                reply: {
                    decode: async (encoded, decryptor, replySignal) => {
                        const answer = parseReply(pingReplySchema, encoded);
                        const pong = await computerPongEventCodec.decode(
                            JSON.stringify(answer.reply),
                            decryptor,
                            replySignal,
                        );
                        return { requestId: pong.requestId, computerLatencyMs: answer.computerLatencyMs };
                    },
                },
                mismatch: "The Computer returned an invalid network response.",
            },
            signal,
        );
        return { computerLatencyMs };
    };

    /** The Computer opens the Session under `conversationKey` once, however often the request is repeated. */
    readonly createSession = async (
        input: {
            readonly conversationKey: string;
            readonly harness: string;
            readonly directory: string;
            readonly configurations: readonly SessionConfigurationSelection[];
        },
        signal: AbortSignal,
    ): Promise<MortyCreatedSession> => {
        const requestId = crypto.randomUUID();
        const operationId = await this.#operationId("create", input.conversationKey, signal);
        const { requestId: _requestId, ...created } = await this.#executor.exchange(
            {
                endpoint: computerEndpoints.createSession({ computerId: this.#computerId }),
                body: await sessionCreateCommandCodec.encode(
                    {
                        kind: "session.create",
                        requestId,
                        operationId,
                        harness: input.harness,
                        configurations: input.configurations,
                        directory: input.directory,
                    },
                    this.#executor.payloadEncryption,
                    signal,
                ),
                requestId,
                reply: {
                    decode: async (encoded, decryptor, replySignal) => {
                        const answer = parseReply(createdSessionReplySchema, encoded);
                        const { ready: encryptedReady, ...access } = answer;
                        const ready = await sessionReadyEventCodec.decode(
                            JSON.stringify(encryptedReady),
                            decryptor,
                            replySignal,
                        );
                        if (!sameNativeSession(access.target, ready.target)) {
                            throw new MortyProtocolError("The Computer returned an invalid Session response.");
                        }
                        return { ...access, ready, requestId: ready.requestId, target: ready.target };
                    },
                },
                mismatch: "The Computer returned an invalid Session response.",
                isAnswer: (reply) =>
                    reply.computerId === this.#computerId && reply.ready.target.harness === input.harness,
            },
            signal,
        );
        return created;
    };

    readonly listSessions = async (signal: AbortSignal): Promise<readonly SessionMetadata[]> => {
        const requestId = crypto.randomUUID();
        const listed = await this.#executor.exchange(
            {
                endpoint: computerEndpoints.listSessions({ computerId: this.#computerId }),
                body: await sessionListCommandCodec.encode(
                    { kind: "session.list", requestId, limit: 500 },
                    this.#executor.payloadEncryption,
                    signal,
                ),
                requestId,
                reply: sessionsListedEventCodec,
                mismatch: "The Computer returned an invalid Session response.",
            },
            signal,
        );
        return listed.entries;
    };

    /** Resolves once the Computer no longer holds the Session; otherwise rejects with the Computer's failure. */
    readonly archiveSession = async (target: NativeSessionTarget, signal: AbortSignal): Promise<void> => {
        const requestId = crypto.randomUUID();
        await this.#executor.exchange(
            {
                endpoint: computerEndpoints.archiveSession({ computerId: this.#computerId }),
                body: await sessionArchiveCommandCodec.encode(
                    { kind: "session.archive", requestId, target },
                    this.#executor.payloadEncryption,
                    signal,
                ),
                requestId,
                target,
                reply: sessionArchivedEventCodec,
                mismatch: "The Computer returned an invalid Session response.",
            },
            signal,
        );
    };

    readonly restoreSession = async (
        target: NativeSessionTarget,
        signal: AbortSignal,
    ): Promise<SessionRestoredEvent> => {
        const requestId = crypto.randomUUID();
        return await this.#executor.exchange(
            {
                endpoint: computerEndpoints.restoreSession({ computerId: this.#computerId }),
                body: await sessionRestoreCommandCodec.encode(
                    { kind: "session.restore", requestId, target },
                    this.#executor.payloadEncryption,
                    signal,
                ),
                requestId,
                target,
                reply: sessionRestoredEventCodec,
                mismatch: "The saved Chat session is invalid.",
            },
            signal,
        );
    };

    readonly prepareSession = async (target: NativeSessionTarget, signal: AbortSignal): Promise<MortySessionAccess> => {
        const requestId = crypto.randomUUID();
        const { requestId: _requestId, ...access } = await this.#executor.exchange(
            {
                endpoint: computerEndpoints.prepareSession({ computerId: this.#computerId }),
                body: await sessionPrepareCommandCodec.encode(
                    { kind: "session.prepare", requestId, target },
                    this.#executor.payloadEncryption,
                    signal,
                ),
                requestId,
                target,
                reply: {
                    decode: async (encoded) => ({ ...parseReply(sessionAccessReplySchema, encoded), requestId }),
                },
                mismatch: "The selected Session could not be verified.",
                isAnswer: (reply) => reply.computerId === this.#computerId,
            },
            signal,
        );
        return access;
    };

    readonly listDirectory = async (directory: string, signal: AbortSignal): Promise<WorkspaceEntriesEvent> => {
        const requestId = crypto.randomUUID();
        return await this.#executor.exchange(
            {
                endpoint: computerEndpoints.listDirectory({ computerId: this.#computerId }),
                body: await workspaceListCommandCodec.encode(
                    { kind: "workspace.list", requestId, directory },
                    this.#executor.payloadEncryption,
                    signal,
                ),
                requestId,
                reply: workspaceEntriesEventCodec,
                mismatch: "The Computer returned an invalid directory response.",
            },
            signal,
        );
    };

    readonly listNativeSessions = async (
        input: { readonly harness: string; readonly directory: string; readonly cursor: string | null },
        signal: AbortSignal,
    ): Promise<NativeSessionAnswer<"list">> => {
        const requestId = crypto.randomUUID();
        return await this.#executor.exchange(
            {
                endpoint: computerEndpoints.listNativeSessions({ computerId: this.#computerId }),
                body: await this.#nativeCommand(
                    { ...input, kind: "native.session.request", action: "list", requestId },
                    signal,
                ),
                requestId,
                reply: nativeAnswer("list"),
                mismatch: "The Computer returned an invalid Session directory.",
            },
            signal,
        );
    };

    readonly findNativeSession = async (
        harness: string,
        sessionId: string,
        signal: AbortSignal,
    ): Promise<NativeSessionEntry> => {
        const requestId = crypto.randomUUID();
        const found = await this.#executor.exchange(
            {
                endpoint: computerEndpoints.continueNativeSession({ computerId: this.#computerId }),
                body: await this.#nativeCommand(
                    { kind: "native.session.request", action: "find", harness, sessionId, directory: ".", requestId },
                    signal,
                ),
                requestId,
                reply: nativeAnswer("find"),
                mismatch: "The Computer returned an invalid Session lookup.",
                isAnswer: (reply) => reply.entry.sessionId === sessionId,
            },
            signal,
        );
        return found.entry;
    };

    readonly importNativeSession = async (
        location: NativeSessionLocation,
        signal: AbortSignal,
    ): Promise<NativeSessionAnswer<"import">> => {
        const requestId = crypto.randomUUID();
        const target = nativeSessionTarget(location);
        return await this.#executor.exchange(
            {
                endpoint: computerEndpoints.continueNativeSession({ computerId: this.#computerId }),
                body: await this.#nativeCommand(
                    {
                        kind: "native.session.request",
                        action: "import",
                        requestId,
                        harness: location.harness,
                        sessionId: location.sessionId,
                        directory: location.directory,
                    },
                    signal,
                ),
                requestId,
                target,
                reply: nativeAnswer("import"),
                mismatch: "The Computer returned an invalid Session import.",
            },
            signal,
        );
    };

    readonly continueNativeSession = async (
        harness: string,
        sessionId: string,
        signal: AbortSignal,
    ): Promise<{ readonly entry: NativeSessionEntry; readonly imported: NativeSessionAnswer<"import"> }> => {
        const entry = await this.findNativeSession(harness, sessionId, signal);
        const imported = await this.importNativeSession({ harness, sessionId, directory: entry.directory }, signal);
        return { entry, imported };
    };

    /** The Computer forks once per `operationId`, so a repeated request finds the fork it already made. */
    readonly forkNativeSession = async (
        operationId: string,
        location: NativeSessionLocation,
        signal: AbortSignal,
    ): Promise<NativeSessionAnswer<"fork">> => {
        const requestId = await nativeForkRequestId(this.#computerId, operationId);
        signal.throwIfAborted();
        return await this.#executor.exchange(
            {
                endpoint: computerEndpoints.forkNativeSession({ computerId: this.#computerId, operationId }),
                body: await this.#nativeCommand(
                    {
                        kind: "native.session.request",
                        action: "fork",
                        requestId,
                        harness: location.harness,
                        sessionId: location.sessionId,
                        directory: location.directory,
                    },
                    signal,
                ),
                requestId,
                reply: nativeAnswer("fork"),
                mismatch: "The Computer returned an invalid fork.",
                isAnswer: (reply) =>
                    reply.target.harness === location.harness && reply.target.sessionId !== location.sessionId,
            },
            signal,
        );
    };

    readonly previewNativeSession = async (location: NativeSessionLocation, signal: AbortSignal) => {
        const requestId = crypto.randomUUID();
        const target = nativeSessionTarget(location);
        const loaded = await this.#executor.exchange(
            {
                endpoint: computerEndpoints.previewNativeSession({
                    computerId: this.#computerId,
                    sessionId: location.sessionId,
                }),
                body: await sessionPreviewHistoryPageLoadCodec.encode(
                    {
                        kind: "session.preview-history.page.load",
                        requestId,
                        target,
                        directory: location.directory,
                        cursor: null,
                        eventLimit: 200,
                    },
                    this.#executor.payloadEncryption,
                    signal,
                ),
                requestId,
                target,
                reply: sessionPreviewHistoryPageLoadedCodec,
                mismatch: "The Computer returned an invalid Session preview.",
            },
            signal,
        );
        return decodeNativeSessionEvents(loaded.events);
    };

    readonly #nativeCommand = async (message: NativeSessionCommand, signal: AbortSignal): Promise<string> =>
        await nativeSessionCommandCodec.encode(message, this.#executor.payloadEncryption, signal);

    readonly #operationId = async (action: string, key: string, signal: AbortSignal): Promise<string> => {
        const digest = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(JSON.stringify([this.#computerId, action, key])),
        );
        signal.throwIfAborted();
        return `${action}_${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    };
}
