import { computerDiagnosticsRequestCodec } from "../computer/diagnostics.ts";
import { COMPUTER_PING_KIND, computerPingCommandCodec } from "../computer/liveness.ts";
import { AGENT_SETTINGS_DISCOVER_KIND, agentSettingsDiscoverCommandCodec } from "../session/agent/settings.ts";
import {
    SESSION_CONFIG_READ_KIND,
    SESSION_CONFIGURE_KIND,
    sessionConfigReadCommandCodec,
    sessionConfigureCommandCodec,
} from "../session/configuration/index.ts";
import { SESSION_RENAME_KIND, sessionRenameCommandCodec } from "../session/configuration/title.ts";
import { SESSION_EVENTS_SUBSCRIBE_KIND, sessionEventsSubscribeCommandCodec } from "../session/events/index.ts";
import {
    CONTENT_COMMIT_KIND,
    CONTENT_WRITE_KIND,
    contentCommitCommandCodec,
    contentWriteCommandCodec,
    FILE_READ_KIND,
    fileReadCommandCodec,
} from "../session/files/index.ts";
import {
    SESSION_ELICITATION_RESPOND_KIND,
    SESSION_PERMISSION_RESPOND_KIND,
    sessionElicitationRespondCommandCodec,
    sessionPermissionRespondCommandCodec,
} from "../session/interactions/index.ts";
import {
    SESSION_ARCHIVE_KIND,
    SESSION_CREATE_KIND,
    SESSION_LIST_KIND,
    SESSION_PREPARE_KIND,
    SESSION_QUERY_KIND,
    SESSION_RESTORE_KIND,
    sessionArchiveCommandCodec,
    sessionCreateCommandCodec,
    sessionListCommandCodec,
    sessionPrepareCommandCodec,
    sessionQueryCommandCodec,
    sessionRestoreCommandCodec,
} from "../session/lifecycle/index.ts";
import {
    NATIVE_SESSION_CANCEL_KIND,
    NATIVE_SESSION_REQUEST_KIND,
    nativeSessionCancelCodec,
    nativeSessionCommandCodec,
} from "../session/native/index.ts";
import {
    SESSION_HISTORY_PAGE_LOAD_KIND,
    SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND,
    sessionHistoryPageLoadCodec,
    sessionPreviewHistoryPageLoadCodec,
} from "../session/observability/history.ts";
import {
    SESSION_CANCEL_BEFORE_START_KIND,
    SESSION_CANCEL_KIND,
    SESSION_PROMPT_DISPOSITION_KIND,
    SESSION_PROMPT_KIND,
    sessionCancelBeforeStartCommandCodec,
    sessionCancelCommandCodec,
    sessionPromptCommandCodec,
    sessionPromptDispositionCommandCodec,
} from "../session/prompt/commands.ts";
import { WORKSPACE_LIST_KIND, workspaceListCommandCodec } from "../session/workspace/index.ts";
import { decodeMessageKind, ProtocolMessageError } from "../shared/message-codec.ts";

import type { daemonInboundSignatures } from "./command-codecs.ts";

export const clientToRelayDecoders = {
    [SESSION_EVENTS_SUBSCRIBE_KIND]: sessionEventsSubscribeCommandCodec.decodeRouting,
    [SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND]: sessionPreviewHistoryPageLoadCodec.decodeRouting,
    [AGENT_SETTINGS_DISCOVER_KIND]: agentSettingsDiscoverCommandCodec.decodeRouting,
    [FILE_READ_KIND]: fileReadCommandCodec.decodeRouting,
    [CONTENT_WRITE_KIND]: contentWriteCommandCodec.decodeRouting,
    [CONTENT_COMMIT_KIND]: contentCommitCommandCodec.decodeRouting,
    [SESSION_LIST_KIND]: sessionListCommandCodec.decodeRouting,
    [SESSION_QUERY_KIND]: sessionQueryCommandCodec.decodeRouting,
    [SESSION_RESTORE_KIND]: sessionRestoreCommandCodec.decodeRouting,
    [SESSION_ARCHIVE_KIND]: sessionArchiveCommandCodec.decodeRouting,
    [NATIVE_SESSION_CANCEL_KIND]: nativeSessionCancelCodec.decodeRouting,
    [NATIVE_SESSION_REQUEST_KIND]: nativeSessionCommandCodec.decodeRouting,
    "computer.diagnostics.read": computerDiagnosticsRequestCodec.decodeRouting,
    [COMPUTER_PING_KIND]: computerPingCommandCodec.decodeRouting,
    [SESSION_CANCEL_BEFORE_START_KIND]: sessionCancelBeforeStartCommandCodec.decodeRouting,
    [SESSION_CANCEL_KIND]: sessionCancelCommandCodec.decodeRouting,
    [SESSION_CONFIGURE_KIND]: sessionConfigureCommandCodec.decodeRouting,
    [SESSION_CONFIG_READ_KIND]: sessionConfigReadCommandCodec.decodeRouting,
    [SESSION_RENAME_KIND]: sessionRenameCommandCodec.decodeRouting,
    [SESSION_ELICITATION_RESPOND_KIND]: sessionElicitationRespondCommandCodec.decodeRouting,
    [SESSION_HISTORY_PAGE_LOAD_KIND]: sessionHistoryPageLoadCodec.decodeRouting,
    [SESSION_PERMISSION_RESPOND_KIND]: sessionPermissionRespondCommandCodec.decodeRouting,
    [SESSION_CREATE_KIND]: sessionCreateCommandCodec.decodeRouting,
    [SESSION_PREPARE_KIND]: sessionPrepareCommandCodec.decodeRouting,
    [SESSION_PROMPT_KIND]: sessionPromptCommandCodec.decodeRouting,
    [SESSION_PROMPT_DISPOSITION_KIND]: sessionPromptDispositionCommandCodec.decodeRouting,
    [WORKSPACE_LIST_KIND]: workspaceListCommandCodec.decodeRouting,
} as const satisfies {
    readonly [K in keyof typeof daemonInboundSignatures]: (encoded: string) => { readonly kind: K };
};

export type ClientToRelayMessage = ReturnType<(typeof clientToRelayDecoders)[keyof typeof clientToRelayDecoders]>;
const clientToRelayRegistry: Readonly<Record<string, (encoded: string) => ClientToRelayMessage>> =
    clientToRelayDecoders;

export function decodeClientToRelayMessage(encoded: string): ClientToRelayMessage {
    const kind = decodeMessageKind(encoded);
    const decoder = clientToRelayRegistry[kind];
    if (decoder === undefined) {
        throw new ProtocolMessageError(`Unknown client-to-relay message kind: ${kind}`);
    }
    return decoder(encoded);
}

export function encodeClientToRelayMessage(message: ClientToRelayMessage): string {
    switch (message.kind) {
        case SESSION_EVENTS_SUBSCRIBE_KIND:
            return sessionEventsSubscribeCommandCodec.encodeRouting(message);
        case SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND:
            return sessionPreviewHistoryPageLoadCodec.encodeRouting(message);
        case AGENT_SETTINGS_DISCOVER_KIND:
            return agentSettingsDiscoverCommandCodec.encodeRouting(message);
        case FILE_READ_KIND:
            return fileReadCommandCodec.encodeRouting(message);
        case CONTENT_WRITE_KIND:
            return contentWriteCommandCodec.encodeRouting(message);
        case CONTENT_COMMIT_KIND:
            return contentCommitCommandCodec.encodeRouting(message);
        case SESSION_LIST_KIND:
            return sessionListCommandCodec.encodeRouting(message);
        case SESSION_QUERY_KIND:
            return sessionQueryCommandCodec.encodeRouting(message);
        case SESSION_RESTORE_KIND:
            return sessionRestoreCommandCodec.encodeRouting(message);
        case SESSION_ARCHIVE_KIND:
            return sessionArchiveCommandCodec.encodeRouting(message);
        case NATIVE_SESSION_CANCEL_KIND:
            return nativeSessionCancelCodec.encodeRouting(message);
        case NATIVE_SESSION_REQUEST_KIND:
            return nativeSessionCommandCodec.encodeRouting(message);
        case "computer.diagnostics.read":
            return computerDiagnosticsRequestCodec.encodeRouting(message);
        case COMPUTER_PING_KIND:
            return computerPingCommandCodec.encodeRouting(message);
        case SESSION_CANCEL_BEFORE_START_KIND:
            return sessionCancelBeforeStartCommandCodec.encodeRouting(message);
        case SESSION_CANCEL_KIND:
            return sessionCancelCommandCodec.encodeRouting(message);
        case SESSION_CONFIGURE_KIND:
            return sessionConfigureCommandCodec.encodeRouting(message);
        case SESSION_CONFIG_READ_KIND:
            return sessionConfigReadCommandCodec.encodeRouting(message);
        case SESSION_RENAME_KIND:
            return sessionRenameCommandCodec.encodeRouting(message);
        case SESSION_ELICITATION_RESPOND_KIND:
            return sessionElicitationRespondCommandCodec.encodeRouting(message);
        case SESSION_HISTORY_PAGE_LOAD_KIND:
            return sessionHistoryPageLoadCodec.encodeRouting(message);
        case SESSION_PERMISSION_RESPOND_KIND:
            return sessionPermissionRespondCommandCodec.encodeRouting(message);
        case SESSION_CREATE_KIND:
            return sessionCreateCommandCodec.encodeRouting(message);
        case SESSION_PREPARE_KIND:
            return sessionPrepareCommandCodec.encodeRouting(message);
        case SESSION_PROMPT_KIND:
            return sessionPromptCommandCodec.encodeRouting(message);
        case SESSION_PROMPT_DISPOSITION_KIND:
            return sessionPromptDispositionCommandCodec.encodeRouting(message);
        case WORKSPACE_LIST_KIND:
            return workspaceListCommandCodec.encodeRouting(message);
    }
}
