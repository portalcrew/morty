import {
    decodeComputerDiagnosticsRequest,
    decodeComputerDiagnosticsResult,
    encodeComputerDiagnosticsRequest,
    encodeComputerDiagnosticsResult,
} from "../computer/diagnostics.ts";
import {
    COMPUTER_HEARTBEAT_ACK_KIND,
    COMPUTER_HEARTBEAT_KIND,
    COMPUTER_LIVENESS_READY_KIND,
    COMPUTER_PING_KIND,
    COMPUTER_PONG_KIND,
    decodeComputerHeartbeatAckEvent,
    decodeComputerHeartbeatEvent,
    decodeComputerLivenessReadyEvent,
    decodeComputerPingCommand,
    decodeComputerPongEvent,
    encodeComputerHeartbeatAckEvent,
    encodeComputerHeartbeatEvent,
    encodeComputerLivenessReadyEvent,
    encodeComputerPingCommand,
    encodeComputerPongEvent,
} from "../computer/liveness.ts";
import {
    AGENT_SETTINGS_DISCOVER_KIND,
    AGENT_SETTINGS_DISCOVERED_KIND,
    AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
    decodeAgentSettingsDiscoverCommand,
    decodeAgentSettingsDiscoveredEvent,
    decodeAgentSettingsDiscoveryFailedEvent,
    encodeAgentSettingsDiscoverCommand,
    encodeAgentSettingsDiscoveredEvent,
    encodeAgentSettingsDiscoveryFailedEvent,
} from "../session/agent/settings.ts";
import {
    decodeSessionConfigReadCommand,
    decodeSessionConfigReadResult,
    decodeSessionConfigUpdatedEvent,
    decodeSessionConfigureCommand,
    encodeSessionConfigReadCommand,
    encodeSessionConfigReadResult,
    encodeSessionConfigUpdatedEvent,
    encodeSessionConfigureCommand,
    SESSION_CONFIG_READ_KIND,
    SESSION_CONFIG_READ_RESULT_KIND,
    SESSION_CONFIG_UPDATED_KIND,
    SESSION_CONFIGURE_KIND,
} from "../session/configuration/index.ts";
import {
    decodeSessionRenameCommand,
    decodeSessionRenamedEvent,
    encodeSessionRenameCommand,
    encodeSessionRenamedEvent,
    SESSION_RENAME_KIND,
    SESSION_RENAMED_KIND,
} from "../session/configuration/title.ts";
import {
    decodeSessionEventEnvelope,
    decodeSessionWireEnvelope,
    encodeSessionEventEnvelope,
    SESSION_EVENT_KIND,
    type SessionWireEnvelope,
} from "../session/events/index.ts";
import {
    CONTENT_AVAILABLE_KIND,
    CONTENT_COMMIT_KIND,
    CONTENT_READY_KIND,
    CONTENT_WRITE_KIND,
    decodeContentAvailableEvent,
    decodeContentCommitCommand,
    decodeContentReadyEvent,
    decodeContentWriteCommand,
    decodeFileBeginEvent,
    decodeFileEndEvent,
    decodeFileFailedEvent,
    decodeFileReadCommand,
    encodeContentAvailableEvent,
    encodeContentCommitCommand,
    encodeContentReadyEvent,
    encodeContentWriteCommand,
    encodeFileBeginEvent,
    encodeFileEndEvent,
    encodeFileFailedEvent,
    encodeFileReadCommand,
    FILE_BEGIN_KIND,
    FILE_END_KIND,
    FILE_FAILED_KIND,
    FILE_READ_KIND,
} from "../session/files/index.ts";
import {
    decodeSessionElicitationRespondCommand,
    decodeSessionInteractionAnsweredEvent,
    decodeSessionPermissionRespondCommand,
    encodeSessionElicitationRespondCommand,
    encodeSessionInteractionAnsweredEvent,
    encodeSessionPermissionRespondCommand,
    SESSION_ELICITATION_RESPOND_KIND,
    SESSION_INTERACTION_ANSWERED_KIND,
    SESSION_PERMISSION_RESPOND_KIND,
} from "../session/interactions/index.ts";
import {
    decodeSessionArchiveCommand,
    decodeSessionArchivedEvent,
    decodeSessionCloseNoticeEvent,
    decodeSessionCreateCommand,
    decodeSessionListCommand,
    decodeSessionOperationFailedEvent,
    decodeSessionPrepareCommand,
    decodeSessionPromptAcceptedEvent,
    decodeSessionQueryCommand,
    decodeSessionReadyEvent,
    decodeSessionRestoreCommand,
    decodeSessionRestoredEvent,
    decodeSessionsListedEvent,
    decodeSessionsQueriedEvent,
    encodeSessionArchiveCommand,
    encodeSessionArchivedEvent,
    encodeSessionCloseNoticeEvent,
    encodeSessionCreateCommand,
    encodeSessionListCommand,
    encodeSessionOperationFailedEvent,
    encodeSessionPrepareCommand,
    encodeSessionPromptAcceptedEvent,
    encodeSessionQueryCommand,
    encodeSessionReadyEvent,
    encodeSessionRestoreCommand,
    encodeSessionRestoredEvent,
    encodeSessionsListedEvent,
    encodeSessionsQueriedEvent,
    SESSION_ARCHIVE_KIND,
    SESSION_ARCHIVED_KIND,
    SESSION_CLOSE_NOTICE_KIND,
    SESSION_CREATE_KIND,
    SESSION_LIST_KIND,
    SESSION_LISTED_KIND,
    SESSION_OPERATION_FAILED_KIND,
    SESSION_PREPARE_KIND,
    SESSION_PROMPT_ACCEPTED_KIND,
    SESSION_QUERIED_KIND,
    SESSION_QUERY_KIND,
    SESSION_READY_KIND,
    SESSION_RESTORE_KIND,
    SESSION_RESTORED_KIND,
} from "../session/lifecycle/index.ts";
import {
    decodeNativeSessionCancel,
    decodeNativeSessionCommand,
    decodeNativeSessionResult,
    encodeNativeSessionCancel,
    encodeNativeSessionCommand,
    encodeNativeSessionResult,
    NATIVE_SESSION_CANCEL_KIND,
    NATIVE_SESSION_REQUEST_KIND,
    NATIVE_SESSION_RESULT_KIND,
} from "../session/native/index.ts";
import {
    decodeSessionHistoryPageLoad,
    decodeSessionHistoryPageLoaded,
    decodeSessionHistoryWirePageLoaded,
    decodeSessionPreviewHistoryPageLoad,
    decodeSessionPreviewHistoryPageLoaded,
    decodeSessionPreviewHistoryWirePageLoaded,
    encodeSessionHistoryPageLoad,
    encodeSessionHistoryPageLoaded,
    encodeSessionPreviewHistoryPageLoad,
    encodeSessionPreviewHistoryPageLoaded,
    SESSION_HISTORY_PAGE_LOAD_KIND,
    SESSION_HISTORY_PAGE_LOADED_KIND,
    SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND,
    SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND,
    type SessionHistoryWirePageLoaded,
    type SessionPreviewHistoryWirePageLoaded,
} from "../session/observability/history.ts";
import {
    decodeSessionCancelBeforeStartCommand,
    decodeSessionCancelCommand,
    decodeSessionPromptCommand,
    decodeSessionPromptDispositionCommand,
    decodeSessionPromptSteeredEvent,
    decodeSessionTurnStoppedEvent,
    decodeSessionTurnWithdrawnEvent,
    encodeSessionCancelBeforeStartCommand,
    encodeSessionCancelCommand,
    encodeSessionPromptCommand,
    encodeSessionPromptDispositionCommand,
    encodeSessionPromptSteeredEvent,
    encodeSessionTurnStoppedEvent,
    encodeSessionTurnWithdrawnEvent,
    SESSION_CANCEL_BEFORE_START_KIND,
    SESSION_CANCEL_KIND,
    SESSION_PROMPT_DISPOSITION_KIND,
    SESSION_PROMPT_KIND,
    SESSION_PROMPT_STEERED_KIND,
    SESSION_TURN_STOPPED_KIND,
    SESSION_TURN_WITHDRAWN_KIND,
} from "../session/prompt/commands.ts";
import { type NativeSessionTarget, readNativeSessionTarget } from "../session/shared/native-session-target.ts";
import {
    decodeWorkspaceEntriesEvent,
    decodeWorkspaceListCommand,
    encodeWorkspaceEntriesEvent,
    encodeWorkspaceListCommand,
    WORKSPACE_ENTRIES_KIND,
    WORKSPACE_LIST_KIND,
} from "../session/workspace/index.ts";
import { isIdentifier } from "../shared/identifier.ts";
import { decodeMessageKind, ProtocolMessageError } from "../shared/message-codec.ts";

interface MessageSignature<TMessage extends { readonly kind: string }> {
    readonly decoder: (encoded: string) => TMessage;
    readonly encoder: (message: unknown) => string;
    readonly kind: TMessage["kind"];
    readonly schema: (message: unknown) => TMessage;
}

function defineMessageSignature<TMessage extends { readonly kind: string }>(
    kind: TMessage["kind"],
    encoder: (message: TMessage) => string,
    decoder: (encoded: string) => TMessage,
): MessageSignature<TMessage> {
    const schema = (message: unknown): TMessage => decoder(JSON.stringify(message));
    return {
        decoder,
        encoder: (message) => encoder(schema(message)),
        kind,
        schema,
    };
}

const serviceToDaemonSignatures = {
    [SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND]: defineMessageSignature(
        SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND,
        encodeSessionPreviewHistoryPageLoad,
        decodeSessionPreviewHistoryPageLoad,
    ),
    [AGENT_SETTINGS_DISCOVER_KIND]: defineMessageSignature(
        AGENT_SETTINGS_DISCOVER_KIND,
        encodeAgentSettingsDiscoverCommand,
        decodeAgentSettingsDiscoverCommand,
    ),
    [FILE_READ_KIND]: defineMessageSignature(FILE_READ_KIND, encodeFileReadCommand, decodeFileReadCommand),
    [CONTENT_WRITE_KIND]: defineMessageSignature(
        CONTENT_WRITE_KIND,
        encodeContentWriteCommand,
        decodeContentWriteCommand,
    ),
    [CONTENT_COMMIT_KIND]: defineMessageSignature(
        CONTENT_COMMIT_KIND,
        encodeContentCommitCommand,
        decodeContentCommitCommand,
    ),
    [SESSION_LIST_KIND]: defineMessageSignature(SESSION_LIST_KIND, encodeSessionListCommand, decodeSessionListCommand),
    [SESSION_QUERY_KIND]: defineMessageSignature(
        SESSION_QUERY_KIND,
        encodeSessionQueryCommand,
        decodeSessionQueryCommand,
    ),
    [SESSION_RESTORE_KIND]: defineMessageSignature(
        SESSION_RESTORE_KIND,
        encodeSessionRestoreCommand,
        decodeSessionRestoreCommand,
    ),
    [SESSION_ARCHIVE_KIND]: defineMessageSignature(
        SESSION_ARCHIVE_KIND,
        encodeSessionArchiveCommand,
        decodeSessionArchiveCommand,
    ),
    [NATIVE_SESSION_CANCEL_KIND]: defineMessageSignature(
        NATIVE_SESSION_CANCEL_KIND,
        encodeNativeSessionCancel,
        decodeNativeSessionCancel,
    ),
    [NATIVE_SESSION_REQUEST_KIND]: defineMessageSignature(
        NATIVE_SESSION_REQUEST_KIND,
        encodeNativeSessionCommand,
        decodeNativeSessionCommand,
    ),
    [COMPUTER_HEARTBEAT_ACK_KIND]: defineMessageSignature(
        COMPUTER_HEARTBEAT_ACK_KIND,
        encodeComputerHeartbeatAckEvent,
        decodeComputerHeartbeatAckEvent,
    ),
    [COMPUTER_LIVENESS_READY_KIND]: defineMessageSignature(
        COMPUTER_LIVENESS_READY_KIND,
        encodeComputerLivenessReadyEvent,
        decodeComputerLivenessReadyEvent,
    ),
    "computer.diagnostics.read": defineMessageSignature(
        "computer.diagnostics.read",
        encodeComputerDiagnosticsRequest,
        decodeComputerDiagnosticsRequest,
    ),
    [COMPUTER_PING_KIND]: defineMessageSignature(
        COMPUTER_PING_KIND,
        encodeComputerPingCommand,
        decodeComputerPingCommand,
    ),
    [SESSION_CANCEL_BEFORE_START_KIND]: defineMessageSignature(
        SESSION_CANCEL_BEFORE_START_KIND,
        encodeSessionCancelBeforeStartCommand,
        decodeSessionCancelBeforeStartCommand,
    ),
    [SESSION_CANCEL_KIND]: defineMessageSignature(
        SESSION_CANCEL_KIND,
        encodeSessionCancelCommand,
        decodeSessionCancelCommand,
    ),
    [SESSION_CONFIGURE_KIND]: defineMessageSignature(
        SESSION_CONFIGURE_KIND,
        encodeSessionConfigureCommand,
        decodeSessionConfigureCommand,
    ),
    [SESSION_CONFIG_READ_KIND]: defineMessageSignature(
        SESSION_CONFIG_READ_KIND,
        encodeSessionConfigReadCommand,
        decodeSessionConfigReadCommand,
    ),
    [SESSION_RENAME_KIND]: defineMessageSignature(
        SESSION_RENAME_KIND,
        encodeSessionRenameCommand,
        decodeSessionRenameCommand,
    ),
    [SESSION_ELICITATION_RESPOND_KIND]: defineMessageSignature(
        SESSION_ELICITATION_RESPOND_KIND,
        encodeSessionElicitationRespondCommand,
        decodeSessionElicitationRespondCommand,
    ),
    [SESSION_HISTORY_PAGE_LOAD_KIND]: defineMessageSignature(
        SESSION_HISTORY_PAGE_LOAD_KIND,
        encodeSessionHistoryPageLoad,
        decodeSessionHistoryPageLoad,
    ),
    [SESSION_PERMISSION_RESPOND_KIND]: defineMessageSignature(
        SESSION_PERMISSION_RESPOND_KIND,
        encodeSessionPermissionRespondCommand,
        decodeSessionPermissionRespondCommand,
    ),
    [SESSION_CREATE_KIND]: defineMessageSignature(
        SESSION_CREATE_KIND,
        encodeSessionCreateCommand,
        decodeSessionCreateCommand,
    ),
    [SESSION_PREPARE_KIND]: defineMessageSignature(
        SESSION_PREPARE_KIND,
        encodeSessionPrepareCommand,
        decodeSessionPrepareCommand,
    ),
    [SESSION_PROMPT_KIND]: defineMessageSignature(
        SESSION_PROMPT_KIND,
        encodeSessionPromptCommand,
        decodeSessionPromptCommand,
    ),
    [SESSION_PROMPT_DISPOSITION_KIND]: defineMessageSignature(
        SESSION_PROMPT_DISPOSITION_KIND,
        encodeSessionPromptDispositionCommand,
        decodeSessionPromptDispositionCommand,
    ),
    [WORKSPACE_LIST_KIND]: defineMessageSignature(
        WORKSPACE_LIST_KIND,
        encodeWorkspaceListCommand,
        decodeWorkspaceListCommand,
    ),
} as const;

export type ServiceToDaemonMessage = ReturnType<
    (typeof serviceToDaemonSignatures)[keyof typeof serviceToDaemonSignatures]["decoder"]
>;

const serviceToDaemonRegistry: Readonly<Record<string, MessageSignature<ServiceToDaemonMessage>>> =
    serviceToDaemonSignatures;

/** Decodes a message this client can consume, or skips it when its schema is not understood. */
export function decodeKnownServiceToDaemonMessage(encoded: string): ServiceToDaemonMessage | null {
    try {
        return decodeServiceToDaemonMessage(encoded);
    } catch {
        return null;
    }
}

export function decodeServiceToDaemonMessage(encoded: string): ServiceToDaemonMessage {
    const kind = decodeMessageKind(encoded);
    const signature = serviceToDaemonRegistry[kind];
    if (signature === undefined) {
        throw new ProtocolMessageError(`Unknown service-to-daemon message kind: ${kind}`);
    }
    return signature.decoder(encoded);
}

export function encodeServiceToDaemonMessage(message: ServiceToDaemonMessage): string {
    return serviceToDaemonSignatures[message.kind].encoder(message);
}

/** A message that asks the Computer for an answer; liveness signals of the connection itself ask for none. */
export type ServiceToDaemonRequest = Exclude<
    ServiceToDaemonMessage,
    { readonly kind: typeof COMPUTER_HEARTBEAT_ACK_KIND | typeof COMPUTER_LIVENESS_READY_KIND }
>;

/**
 * The address of a request: every answer to it, `session.operation.failed` included, carries this value as its
 * `requestId`. For a prompt this equals the Turn's `commandId`.
 * Senders, the Relay and the Computer all address replies through this one rule.
 */
export function requestReplyAddress(request: ServiceToDaemonRequest): string {
    return request.requestId;
}

/**
 * Reads, by the same rule, the address and Session of a request the receiver could not decode, so that it can still
 * answer it with a refusal. Null when the message names no address to answer.
 */
export function readUndecodedRequestAddress(
    encoded: string,
): { readonly requestId: string; readonly target: NativeSessionTarget | undefined } | null {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch {
        return null;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return null;
    }
    const requestId: unknown = Reflect.get(value, "requestId");
    if (!isIdentifier(requestId)) {
        return null;
    }
    return { requestId, target: readNativeSessionTarget(Reflect.get(value, "target")) ?? undefined };
}

const daemonToServiceSignatures = {
    [SESSION_ARCHIVED_KIND]: defineMessageSignature(
        SESSION_ARCHIVED_KIND,
        encodeSessionArchivedEvent,
        decodeSessionArchivedEvent,
    ),
    [SESSION_CLOSE_NOTICE_KIND]: defineMessageSignature(
        SESSION_CLOSE_NOTICE_KIND,
        encodeSessionCloseNoticeEvent,
        decodeSessionCloseNoticeEvent,
    ),
    [SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND]: defineMessageSignature(
        SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND,
        encodeSessionPreviewHistoryPageLoaded,
        decodeSessionPreviewHistoryPageLoaded,
    ),
    [SESSION_CONFIG_UPDATED_KIND]: defineMessageSignature(
        SESSION_CONFIG_UPDATED_KIND,
        encodeSessionConfigUpdatedEvent,
        decodeSessionConfigUpdatedEvent,
    ),
    [SESSION_CONFIG_READ_RESULT_KIND]: defineMessageSignature(
        SESSION_CONFIG_READ_RESULT_KIND,
        encodeSessionConfigReadResult,
        decodeSessionConfigReadResult,
    ),
    [SESSION_RENAMED_KIND]: defineMessageSignature(
        SESSION_RENAMED_KIND,
        encodeSessionRenamedEvent,
        decodeSessionRenamedEvent,
    ),
    [AGENT_SETTINGS_DISCOVERED_KIND]: defineMessageSignature(
        AGENT_SETTINGS_DISCOVERED_KIND,
        encodeAgentSettingsDiscoveredEvent,
        decodeAgentSettingsDiscoveredEvent,
    ),
    [AGENT_SETTINGS_DISCOVERY_FAILED_KIND]: defineMessageSignature(
        AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
        encodeAgentSettingsDiscoveryFailedEvent,
        decodeAgentSettingsDiscoveryFailedEvent,
    ),
    [FILE_BEGIN_KIND]: defineMessageSignature(FILE_BEGIN_KIND, encodeFileBeginEvent, decodeFileBeginEvent),
    [FILE_END_KIND]: defineMessageSignature(FILE_END_KIND, encodeFileEndEvent, decodeFileEndEvent),
    [FILE_FAILED_KIND]: defineMessageSignature(FILE_FAILED_KIND, encodeFileFailedEvent, decodeFileFailedEvent),
    [CONTENT_READY_KIND]: defineMessageSignature(CONTENT_READY_KIND, encodeContentReadyEvent, decodeContentReadyEvent),
    [CONTENT_AVAILABLE_KIND]: defineMessageSignature(
        CONTENT_AVAILABLE_KIND,
        encodeContentAvailableEvent,
        decodeContentAvailableEvent,
    ),
    [SESSION_LISTED_KIND]: defineMessageSignature(
        SESSION_LISTED_KIND,
        encodeSessionsListedEvent,
        decodeSessionsListedEvent,
    ),
    [SESSION_QUERIED_KIND]: defineMessageSignature(
        SESSION_QUERIED_KIND,
        encodeSessionsQueriedEvent,
        decodeSessionsQueriedEvent,
    ),
    [SESSION_RESTORED_KIND]: defineMessageSignature(
        SESSION_RESTORED_KIND,
        encodeSessionRestoredEvent,
        decodeSessionRestoredEvent,
    ),
    [NATIVE_SESSION_RESULT_KIND]: defineMessageSignature(
        NATIVE_SESSION_RESULT_KIND,
        encodeNativeSessionResult,
        decodeNativeSessionResult,
    ),
    [COMPUTER_HEARTBEAT_KIND]: defineMessageSignature(
        COMPUTER_HEARTBEAT_KIND,
        encodeComputerHeartbeatEvent,
        decodeComputerHeartbeatEvent,
    ),
    "computer.diagnostics.result": defineMessageSignature(
        "computer.diagnostics.result",
        encodeComputerDiagnosticsResult,
        decodeComputerDiagnosticsResult,
    ),
    [COMPUTER_PONG_KIND]: defineMessageSignature(COMPUTER_PONG_KIND, encodeComputerPongEvent, decodeComputerPongEvent),
    [SESSION_EVENT_KIND]: defineMessageSignature(
        SESSION_EVENT_KIND,
        encodeSessionEventEnvelope,
        decodeSessionEventEnvelope,
    ),
    [SESSION_OPERATION_FAILED_KIND]: defineMessageSignature(
        SESSION_OPERATION_FAILED_KIND,
        encodeSessionOperationFailedEvent,
        decodeSessionOperationFailedEvent,
    ),
    [SESSION_PROMPT_ACCEPTED_KIND]: defineMessageSignature(
        SESSION_PROMPT_ACCEPTED_KIND,
        encodeSessionPromptAcceptedEvent,
        decodeSessionPromptAcceptedEvent,
    ),
    [SESSION_PROMPT_STEERED_KIND]: defineMessageSignature(
        SESSION_PROMPT_STEERED_KIND,
        encodeSessionPromptSteeredEvent,
        decodeSessionPromptSteeredEvent,
    ),
    [SESSION_TURN_STOPPED_KIND]: defineMessageSignature(
        SESSION_TURN_STOPPED_KIND,
        encodeSessionTurnStoppedEvent,
        decodeSessionTurnStoppedEvent,
    ),
    [SESSION_TURN_WITHDRAWN_KIND]: defineMessageSignature(
        SESSION_TURN_WITHDRAWN_KIND,
        encodeSessionTurnWithdrawnEvent,
        decodeSessionTurnWithdrawnEvent,
    ),
    [SESSION_INTERACTION_ANSWERED_KIND]: defineMessageSignature(
        SESSION_INTERACTION_ANSWERED_KIND,
        encodeSessionInteractionAnsweredEvent,
        decodeSessionInteractionAnsweredEvent,
    ),
    [SESSION_HISTORY_PAGE_LOADED_KIND]: defineMessageSignature(
        SESSION_HISTORY_PAGE_LOADED_KIND,
        encodeSessionHistoryPageLoaded,
        decodeSessionHistoryPageLoaded,
    ),
    [SESSION_READY_KIND]: defineMessageSignature(SESSION_READY_KIND, encodeSessionReadyEvent, decodeSessionReadyEvent),
    [WORKSPACE_ENTRIES_KIND]: defineMessageSignature(
        WORKSPACE_ENTRIES_KIND,
        encodeWorkspaceEntriesEvent,
        decodeWorkspaceEntriesEvent,
    ),
} as const;

export type DaemonToServiceMessage = ReturnType<
    (typeof daemonToServiceSignatures)[keyof typeof daemonToServiceSignatures]["decoder"]
>;

const daemonToServiceRegistry: Readonly<Record<string, MessageSignature<DaemonToServiceMessage>>> =
    daemonToServiceSignatures;

/** Decodes a message this client can consume, or skips it when its schema is not understood. */
function decodeKnownDaemonToServiceMessage(encoded: string): DaemonToServiceMessage | null {
    const kind = decodeMessageKind(encoded);
    const signature = daemonToServiceRegistry[kind];
    if (signature === undefined) {
        return null;
    }
    try {
        return signature.decoder(encoded);
    } catch {
        return null;
    }
}

export function decodeDaemonToServiceMessage(encoded: string): DaemonToServiceMessage {
    const kind = decodeMessageKind(encoded);
    const signature = daemonToServiceRegistry[kind];
    if (signature === undefined) {
        throw new ProtocolMessageError(`Unknown daemon-to-service message kind: ${kind}`);
    }
    return signature.decoder(encoded);
}

export type DaemonToRelayMessage =
    | Exclude<
          DaemonToServiceMessage,
          {
              readonly kind:
                  | typeof SESSION_EVENT_KIND
                  | typeof SESSION_HISTORY_PAGE_LOADED_KIND
                  | typeof SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND;
          }
      >
    | SessionWireEnvelope
    | SessionHistoryWirePageLoaded
    | SessionPreviewHistoryWirePageLoaded;

export function decodeDaemonToRelayMessage(encoded: string): DaemonToRelayMessage | null {
    const kind = decodeMessageKind(encoded);
    if (kind === SESSION_EVENT_KIND) {
        return decodeSessionWireEnvelope(encoded);
    }
    if (kind === SESSION_HISTORY_PAGE_LOADED_KIND) {
        return decodeSessionHistoryWirePageLoaded(encoded);
    }
    if (kind === SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND) {
        return decodeSessionPreviewHistoryWirePageLoaded(encoded);
    }
    return decodeKnownDaemonToServiceMessage(encoded);
}

export function encodeDaemonToServiceMessage(message: DaemonToServiceMessage): string {
    return daemonToServiceSignatures[message.kind].encoder(message);
}
