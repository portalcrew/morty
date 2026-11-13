import { computerDiagnosticsResultCodec } from "../computer/diagnostics.ts";
import {
    COMPUTER_HEARTBEAT_KIND,
    COMPUTER_PONG_KIND,
    computerPongEventCodec,
    decodeComputerHeartbeatEvent,
} from "../computer/liveness.ts";
import {
    AGENT_SETTINGS_DISCOVERED_KIND,
    AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
    agentSettingsDiscoveredEventCodec,
    agentSettingsDiscoveryFailedEventCodec,
} from "../session/agent/settings.ts";
import {
    SESSION_CONFIG_READ_RESULT_KIND,
    SESSION_CONFIG_UPDATED_KIND,
    sessionConfigReadResultCodec,
    sessionConfigUpdatedEventCodec,
} from "../session/configuration/index.ts";
import { SESSION_RENAMED_KIND, sessionRenamedEventCodec } from "../session/configuration/title.ts";
import { SESSION_EVENT_KIND, sessionEventEnvelopeCodec } from "../session/events/index.ts";
import {
    CONTENT_AVAILABLE_KIND,
    CONTENT_READY_KIND,
    contentAvailableEventCodec,
    contentReadyEventCodec,
    FILE_BEGIN_KIND,
    FILE_END_KIND,
    FILE_FAILED_KIND,
    fileBeginEventCodec,
    fileEndEventCodec,
    fileFailedEventCodec,
} from "../session/files/index.ts";
import {
    SESSION_INTERACTION_ANSWERED_KIND,
    sessionInteractionAnsweredEventCodec,
} from "../session/interactions/index.ts";
import {
    SESSION_ARCHIVED_KIND,
    SESSION_CLOSE_NOTICE_KIND,
    SESSION_LISTED_KIND,
    SESSION_OPERATION_FAILED_KIND,
    SESSION_PROMPT_ACCEPTED_KIND,
    SESSION_QUERIED_KIND,
    SESSION_READY_KIND,
    SESSION_RESTORED_KIND,
    sessionArchivedEventCodec,
    sessionCloseNoticeEventCodec,
    sessionOperationFailedEventCodec,
    sessionPromptAcceptedEventCodec,
    sessionReadyEventCodec,
    sessionRestoredEventCodec,
    sessionsListedEventCodec,
    sessionsQueriedEventCodec,
} from "../session/lifecycle/index.ts";
import { NATIVE_SESSION_RESULT_KIND, nativeSessionResultCodec } from "../session/native/index.ts";
import {
    SESSION_HISTORY_PAGE_LOADED_KIND,
    SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND,
    sessionHistoryPageLoadedCodec,
    sessionPreviewHistoryPageLoadedCodec,
} from "../session/observability/history.ts";
import {
    SESSION_PROMPT_STEERED_KIND,
    SESSION_TURN_STOPPED_KIND,
    SESSION_TURN_WITHDRAWN_KIND,
    sessionPromptSteeredEventCodec,
    sessionTurnStoppedEventCodec,
    sessionTurnWithdrawnEventCodec,
} from "../session/prompt/commands.ts";
import { WORKSPACE_ENTRIES_KIND, workspaceEntriesEventCodec } from "../session/workspace/index.ts";
import { decodeMessageKind, ProtocolMessageError } from "../shared/message-codec.ts";

import type { daemonEventSignatures } from "./event-codecs.ts";

export const daemonToRelayDecoders = {
    [SESSION_ARCHIVED_KIND]: sessionArchivedEventCodec.decodeRouting,
    [SESSION_CLOSE_NOTICE_KIND]: sessionCloseNoticeEventCodec.decodeRouting,
    [SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND]: sessionPreviewHistoryPageLoadedCodec.decodeRouting,
    [SESSION_CONFIG_UPDATED_KIND]: sessionConfigUpdatedEventCodec.decodeRouting,
    [SESSION_CONFIG_READ_RESULT_KIND]: sessionConfigReadResultCodec.decodeRouting,
    [SESSION_RENAMED_KIND]: sessionRenamedEventCodec.decodeRouting,
    [AGENT_SETTINGS_DISCOVERED_KIND]: agentSettingsDiscoveredEventCodec.decodeRouting,
    [AGENT_SETTINGS_DISCOVERY_FAILED_KIND]: agentSettingsDiscoveryFailedEventCodec.decodeRouting,
    [FILE_BEGIN_KIND]: fileBeginEventCodec.decodeRouting,
    [FILE_END_KIND]: fileEndEventCodec.decodeRouting,
    [FILE_FAILED_KIND]: fileFailedEventCodec.decodeRouting,
    [CONTENT_READY_KIND]: contentReadyEventCodec.decodeRouting,
    [CONTENT_AVAILABLE_KIND]: contentAvailableEventCodec.decodeRouting,
    [SESSION_LISTED_KIND]: sessionsListedEventCodec.decodeRouting,
    [SESSION_QUERIED_KIND]: sessionsQueriedEventCodec.decodeRouting,
    [SESSION_RESTORED_KIND]: sessionRestoredEventCodec.decodeRouting,
    [NATIVE_SESSION_RESULT_KIND]: nativeSessionResultCodec.decodeRouting,
    [COMPUTER_HEARTBEAT_KIND]: decodeComputerHeartbeatEvent,
    "computer.diagnostics.result": computerDiagnosticsResultCodec.decodeRouting,
    [COMPUTER_PONG_KIND]: computerPongEventCodec.decodeRouting,
    [SESSION_EVENT_KIND]: sessionEventEnvelopeCodec.decodeRouting,
    [SESSION_OPERATION_FAILED_KIND]: sessionOperationFailedEventCodec.decodeRouting,
    [SESSION_PROMPT_ACCEPTED_KIND]: sessionPromptAcceptedEventCodec.decodeRouting,
    [SESSION_PROMPT_STEERED_KIND]: sessionPromptSteeredEventCodec.decodeRouting,
    [SESSION_TURN_STOPPED_KIND]: sessionTurnStoppedEventCodec.decodeRouting,
    [SESSION_TURN_WITHDRAWN_KIND]: sessionTurnWithdrawnEventCodec.decodeRouting,
    [SESSION_INTERACTION_ANSWERED_KIND]: sessionInteractionAnsweredEventCodec.decodeRouting,
    [SESSION_HISTORY_PAGE_LOADED_KIND]: sessionHistoryPageLoadedCodec.decodeRouting,
    [SESSION_READY_KIND]: sessionReadyEventCodec.decodeRouting,
    [WORKSPACE_ENTRIES_KIND]: workspaceEntriesEventCodec.decodeRouting,
} as const satisfies {
    readonly [K in keyof typeof daemonEventSignatures | typeof COMPUTER_HEARTBEAT_KIND]: (encoded: string) => {
        readonly kind: K;
    };
};

export type DaemonToRelayMessage = ReturnType<(typeof daemonToRelayDecoders)[keyof typeof daemonToRelayDecoders]>;
const daemonToRelayRegistry: Readonly<Record<string, (encoded: string) => DaemonToRelayMessage>> =
    daemonToRelayDecoders;

export function decodeDaemonToRelayMessage(encoded: string): DaemonToRelayMessage {
    const kind = decodeMessageKind(encoded);
    const decoder = daemonToRelayRegistry[kind];
    if (decoder === undefined) {
        throw new ProtocolMessageError(`Unknown daemon-to-relay message kind: ${kind}`);
    }
    return decoder(encoded);
}
