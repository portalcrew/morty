import type { PayloadDecryptor, PayloadEncryptor } from "../../encryption.ts";
import { computerDiagnosticsResultCodec } from "../computer/diagnostics.ts";
import { COMPUTER_PONG_KIND, computerPongEventCodec } from "../computer/liveness.ts";
import { computerMetadataResultCodec } from "../computer/metadata.ts";
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

import { defineMessageSignature } from "./message-signature.ts";

export const daemonEventSignatures = {
    "computer.metadata.result": defineMessageSignature({
        kind: "computer.metadata.result",
        codec: computerMetadataResultCodec,
    }),
    [SESSION_ARCHIVED_KIND]: defineMessageSignature({ kind: SESSION_ARCHIVED_KIND, codec: sessionArchivedEventCodec }),
    [SESSION_CLOSE_NOTICE_KIND]: defineMessageSignature({
        kind: SESSION_CLOSE_NOTICE_KIND,
        codec: sessionCloseNoticeEventCodec,
    }),
    [SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND]: defineMessageSignature({
        kind: SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND,
        codec: sessionPreviewHistoryPageLoadedCodec,
    }),
    [SESSION_CONFIG_UPDATED_KIND]: defineMessageSignature({
        kind: SESSION_CONFIG_UPDATED_KIND,
        codec: sessionConfigUpdatedEventCodec,
    }),
    [SESSION_CONFIG_READ_RESULT_KIND]: defineMessageSignature({
        kind: SESSION_CONFIG_READ_RESULT_KIND,
        codec: sessionConfigReadResultCodec,
    }),
    [SESSION_RENAMED_KIND]: defineMessageSignature({ kind: SESSION_RENAMED_KIND, codec: sessionRenamedEventCodec }),
    [AGENT_SETTINGS_DISCOVERED_KIND]: defineMessageSignature({
        kind: AGENT_SETTINGS_DISCOVERED_KIND,
        codec: agentSettingsDiscoveredEventCodec,
    }),
    [AGENT_SETTINGS_DISCOVERY_FAILED_KIND]: defineMessageSignature({
        kind: AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
        codec: agentSettingsDiscoveryFailedEventCodec,
    }),
    [FILE_BEGIN_KIND]: defineMessageSignature({ kind: FILE_BEGIN_KIND, codec: fileBeginEventCodec }),
    [FILE_END_KIND]: defineMessageSignature({ kind: FILE_END_KIND, codec: fileEndEventCodec }),
    [FILE_FAILED_KIND]: defineMessageSignature({ kind: FILE_FAILED_KIND, codec: fileFailedEventCodec }),
    [CONTENT_READY_KIND]: defineMessageSignature({ kind: CONTENT_READY_KIND, codec: contentReadyEventCodec }),
    [CONTENT_AVAILABLE_KIND]: defineMessageSignature({
        kind: CONTENT_AVAILABLE_KIND,
        codec: contentAvailableEventCodec,
    }),
    [SESSION_LISTED_KIND]: defineMessageSignature({ kind: SESSION_LISTED_KIND, codec: sessionsListedEventCodec }),
    [SESSION_QUERIED_KIND]: defineMessageSignature({ kind: SESSION_QUERIED_KIND, codec: sessionsQueriedEventCodec }),
    [SESSION_RESTORED_KIND]: defineMessageSignature({ kind: SESSION_RESTORED_KIND, codec: sessionRestoredEventCodec }),
    [NATIVE_SESSION_RESULT_KIND]: defineMessageSignature({
        kind: NATIVE_SESSION_RESULT_KIND,
        codec: nativeSessionResultCodec,
    }),
    "computer.diagnostics.result": defineMessageSignature({
        kind: "computer.diagnostics.result",
        codec: computerDiagnosticsResultCodec,
    }),
    [COMPUTER_PONG_KIND]: defineMessageSignature({ kind: COMPUTER_PONG_KIND, codec: computerPongEventCodec }),
    [SESSION_EVENT_KIND]: defineMessageSignature({ kind: SESSION_EVENT_KIND, codec: sessionEventEnvelopeCodec }),
    [SESSION_OPERATION_FAILED_KIND]: defineMessageSignature({
        kind: SESSION_OPERATION_FAILED_KIND,
        codec: sessionOperationFailedEventCodec,
    }),
    [SESSION_PROMPT_ACCEPTED_KIND]: defineMessageSignature({
        kind: SESSION_PROMPT_ACCEPTED_KIND,
        codec: sessionPromptAcceptedEventCodec,
    }),
    [SESSION_PROMPT_STEERED_KIND]: defineMessageSignature({
        kind: SESSION_PROMPT_STEERED_KIND,
        codec: sessionPromptSteeredEventCodec,
    }),
    [SESSION_TURN_STOPPED_KIND]: defineMessageSignature({
        kind: SESSION_TURN_STOPPED_KIND,
        codec: sessionTurnStoppedEventCodec,
    }),
    [SESSION_TURN_WITHDRAWN_KIND]: defineMessageSignature({
        kind: SESSION_TURN_WITHDRAWN_KIND,
        codec: sessionTurnWithdrawnEventCodec,
    }),
    [SESSION_INTERACTION_ANSWERED_KIND]: defineMessageSignature({
        kind: SESSION_INTERACTION_ANSWERED_KIND,
        codec: sessionInteractionAnsweredEventCodec,
    }),
    [SESSION_HISTORY_PAGE_LOADED_KIND]: defineMessageSignature({
        kind: SESSION_HISTORY_PAGE_LOADED_KIND,
        codec: sessionHistoryPageLoadedCodec,
    }),
    [SESSION_READY_KIND]: defineMessageSignature({ kind: SESSION_READY_KIND, codec: sessionReadyEventCodec }),
    [WORKSPACE_ENTRIES_KIND]: defineMessageSignature({
        kind: WORKSPACE_ENTRIES_KIND,
        codec: workspaceEntriesEventCodec,
    }),
} as const;

export type DaemonMessage = Awaited<
    ReturnType<(typeof daemonEventSignatures)[keyof typeof daemonEventSignatures]["decode"]>
>;
const daemonMessageRegistry: Readonly<
    Record<
        string,
        {
            readonly decode: (
                encoded: string,
                decryptor: PayloadDecryptor,
                signal: AbortSignal,
            ) => Promise<DaemonMessage>;
        }
    >
> = daemonEventSignatures;

export function encodeEncryptedDaemonMessage(
    message: DaemonMessage,
    encryptor: PayloadEncryptor,
    signal: AbortSignal,
): Promise<string> {
    return daemonEventSignatures[message.kind].encode(message, encryptor, signal);
}

export function decodeEncryptedDaemonMessage(
    encoded: string,
    decryptor: PayloadDecryptor,
    signal: AbortSignal,
): Promise<DaemonMessage> {
    const signature = daemonMessageRegistry[decodeMessageKind(encoded)];
    if (signature === undefined) {
        throw new ProtocolMessageError("Unknown daemon message kind");
    }
    return signature.decode(encoded, decryptor, signal);
}
