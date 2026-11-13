import type { PayloadDecryptor, PayloadEncryptor } from "../../encryption.ts";
import { computerDiagnosticsRequestCodec } from "../computer/diagnostics.ts";
import { COMPUTER_PING_KIND, computerPingCommandCodec } from "../computer/liveness.ts";
import { computerMetadataRequestCodec } from "../computer/metadata.ts";
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
import { type NativeSessionTarget, readNativeSessionTarget } from "../session/shared/native-session-target.ts";
import { WORKSPACE_LIST_KIND, workspaceListCommandCodec } from "../session/workspace/index.ts";
import { isIdentifier } from "../shared/identifier.ts";
import { decodeMessageKind, ProtocolMessageError } from "../shared/message-codec.ts";

import { defineMessageSignature } from "./message-signature.ts";

export const daemonInboundSignatures = {
    "computer.metadata.read": defineMessageSignature({
        kind: "computer.metadata.read",
        codec: computerMetadataRequestCodec,
    }),
    [SESSION_EVENTS_SUBSCRIBE_KIND]: defineMessageSignature({
        kind: SESSION_EVENTS_SUBSCRIBE_KIND,
        codec: sessionEventsSubscribeCommandCodec,
    }),
    [SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND]: defineMessageSignature({
        kind: SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND,
        codec: sessionPreviewHistoryPageLoadCodec,
    }),
    [AGENT_SETTINGS_DISCOVER_KIND]: defineMessageSignature({
        kind: AGENT_SETTINGS_DISCOVER_KIND,
        codec: agentSettingsDiscoverCommandCodec,
    }),
    [FILE_READ_KIND]: defineMessageSignature({ kind: FILE_READ_KIND, codec: fileReadCommandCodec }),
    [CONTENT_WRITE_KIND]: defineMessageSignature({ kind: CONTENT_WRITE_KIND, codec: contentWriteCommandCodec }),
    [CONTENT_COMMIT_KIND]: defineMessageSignature({ kind: CONTENT_COMMIT_KIND, codec: contentCommitCommandCodec }),
    [SESSION_LIST_KIND]: defineMessageSignature({ kind: SESSION_LIST_KIND, codec: sessionListCommandCodec }),
    [SESSION_QUERY_KIND]: defineMessageSignature({ kind: SESSION_QUERY_KIND, codec: sessionQueryCommandCodec }),
    [SESSION_RESTORE_KIND]: defineMessageSignature({ kind: SESSION_RESTORE_KIND, codec: sessionRestoreCommandCodec }),
    [SESSION_ARCHIVE_KIND]: defineMessageSignature({ kind: SESSION_ARCHIVE_KIND, codec: sessionArchiveCommandCodec }),
    [NATIVE_SESSION_CANCEL_KIND]: defineMessageSignature({
        kind: NATIVE_SESSION_CANCEL_KIND,
        codec: nativeSessionCancelCodec,
    }),
    [NATIVE_SESSION_REQUEST_KIND]: defineMessageSignature({
        kind: NATIVE_SESSION_REQUEST_KIND,
        codec: nativeSessionCommandCodec,
    }),
    "computer.diagnostics.read": defineMessageSignature({
        kind: "computer.diagnostics.read",
        codec: computerDiagnosticsRequestCodec,
    }),
    [COMPUTER_PING_KIND]: defineMessageSignature({ kind: COMPUTER_PING_KIND, codec: computerPingCommandCodec }),
    [SESSION_CANCEL_BEFORE_START_KIND]: defineMessageSignature({
        kind: SESSION_CANCEL_BEFORE_START_KIND,
        codec: sessionCancelBeforeStartCommandCodec,
    }),
    [SESSION_CANCEL_KIND]: defineMessageSignature({ kind: SESSION_CANCEL_KIND, codec: sessionCancelCommandCodec }),
    [SESSION_CONFIGURE_KIND]: defineMessageSignature({
        kind: SESSION_CONFIGURE_KIND,
        codec: sessionConfigureCommandCodec,
    }),
    [SESSION_CONFIG_READ_KIND]: defineMessageSignature({
        kind: SESSION_CONFIG_READ_KIND,
        codec: sessionConfigReadCommandCodec,
    }),
    [SESSION_RENAME_KIND]: defineMessageSignature({ kind: SESSION_RENAME_KIND, codec: sessionRenameCommandCodec }),
    [SESSION_ELICITATION_RESPOND_KIND]: defineMessageSignature({
        kind: SESSION_ELICITATION_RESPOND_KIND,
        codec: sessionElicitationRespondCommandCodec,
    }),
    [SESSION_HISTORY_PAGE_LOAD_KIND]: defineMessageSignature({
        kind: SESSION_HISTORY_PAGE_LOAD_KIND,
        codec: sessionHistoryPageLoadCodec,
    }),
    [SESSION_PERMISSION_RESPOND_KIND]: defineMessageSignature({
        kind: SESSION_PERMISSION_RESPOND_KIND,
        codec: sessionPermissionRespondCommandCodec,
    }),
    [SESSION_CREATE_KIND]: defineMessageSignature({ kind: SESSION_CREATE_KIND, codec: sessionCreateCommandCodec }),
    [SESSION_PREPARE_KIND]: defineMessageSignature({ kind: SESSION_PREPARE_KIND, codec: sessionPrepareCommandCodec }),
    [SESSION_PROMPT_KIND]: defineMessageSignature({ kind: SESSION_PROMPT_KIND, codec: sessionPromptCommandCodec }),
    [SESSION_PROMPT_DISPOSITION_KIND]: defineMessageSignature({
        kind: SESSION_PROMPT_DISPOSITION_KIND,
        codec: sessionPromptDispositionCommandCodec,
    }),
    [WORKSPACE_LIST_KIND]: defineMessageSignature({ kind: WORKSPACE_LIST_KIND, codec: workspaceListCommandCodec }),
} as const;

export type ClientCommand = Awaited<
    ReturnType<(typeof daemonInboundSignatures)[keyof typeof daemonInboundSignatures]["decode"]>
>;
const daemonInboundRegistry: Readonly<
    Record<
        string,
        {
            readonly decode: (
                encoded: string,
                decryptor: PayloadDecryptor,
                signal: AbortSignal,
            ) => Promise<ClientCommand>;
        }
    >
> = daemonInboundSignatures;

export function encodeEncryptedDaemonInboundMessage(
    message: ClientCommand,
    encryptor: PayloadEncryptor,
    signal: AbortSignal,
): Promise<string> {
    return daemonInboundSignatures[message.kind].encode(message, encryptor, signal);
}

export function decodeEncryptedDaemonInboundMessage(
    encoded: string,
    decryptor: PayloadDecryptor,
    signal: AbortSignal,
): Promise<ClientCommand> {
    const signature = daemonInboundRegistry[decodeMessageKind(encoded)];
    if (signature === undefined) {
        throw new ProtocolMessageError("Unknown daemon inbound message kind");
    }
    return signature.decode(encoded, decryptor, signal);
}

/** A message that asks the Computer for an answer; liveness signals of the connection itself ask for none. */
export type ClientRequest = Exclude<ClientCommand, { readonly kind: typeof SESSION_EVENTS_SUBSCRIBE_KIND }>;

/**
 * The address of a request: every answer to it, `session.operation.failed` included, carries this value as its
 * `requestId`. Senders, the Relay and the Computer all address replies through this one rule.
 */
export function requestReplyAddress(request: ClientRequest): string {
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
