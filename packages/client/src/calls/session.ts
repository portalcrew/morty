import { decodeNativeSessionTarget, isIdentifier, type NativeSessionTarget } from "@morty-build/client/protocol";
import { MortyValidationError } from "../errors.ts";
import {
    sessionConfigReadCommandCodec,
    sessionConfigReadResultCodec,
    sessionConfigUpdatedEventCodec,
    sessionConfigureCommandCodec,
} from "../protocol/session/configuration/index.ts";
import { sessionRenameCommandCodec, sessionRenamedEventCodec } from "../protocol/session/configuration/title.ts";
import { sessionEventEnvelopeCodec, sessionEventsSubscribeCommandCodec } from "../protocol/session/events/index.ts";
import {
    contentAvailableEventCodec,
    contentCommitCommandCodec,
    contentReadyEventCodec,
    contentWriteCommandCodec,
    fileBeginEventCodec,
    fileEndEventCodec,
    fileFailedEventCodec,
    fileReadCommandCodec,
} from "../protocol/session/files/index.ts";
import {
    sessionElicitationRespondCommandCodec,
    sessionInteractionAnsweredEventCodec,
    sessionPermissionRespondCommandCodec,
} from "../protocol/session/interactions/index.ts";
import {
    sessionCloseNoticeEventCodec,
    sessionOperationFailedEventCodec,
    sessionPromptAcceptedEventCodec,
} from "../protocol/session/lifecycle/index.ts";
import { nativeSessionRequestCodec, nativeSessionResultCodec } from "../protocol/session/native/index.ts";
import {
    sessionHistoryPageLoadCodec,
    sessionHistoryPageLoadedCodec,
} from "../protocol/session/observability/history.ts";
import {
    sessionCancelBeforeStartCommandCodec,
    sessionCancelCommandCodec,
    sessionPromptCommandCodec,
    sessionPromptDispositionCommandCodec,
    sessionPromptSteeredEventCodec,
    sessionTurnStoppedEventCodec,
    sessionTurnWithdrawnEventCodec,
} from "../protocol/session/prompt/commands.ts";
import type { MortyEndpointCall, MortyTransportPolicy } from "./call.ts";

export interface SessionCallTarget {
    readonly computerId: string;
    readonly target: NativeSessionTarget;
}

function endpoint({
    computerId,
    target,
    method,
    resource,
    transport,
    timeoutMilliseconds,
    query,
    encrypted,
}: SessionCallTarget & {
    readonly method: MortyEndpointCall["method"];
    readonly resource: string;
    readonly transport: MortyTransportPolicy;
    readonly timeoutMilliseconds: number;
    readonly query?: URLSearchParams;
    readonly encrypted: MortyEndpointCall["encrypted"];
}): MortyEndpointCall {
    if (!isIdentifier(computerId)) {
        throw new MortyValidationError("The Morty Computer identifier is invalid");
    }
    let parsed: NativeSessionTarget;
    try {
        parsed = decodeNativeSessionTarget(target);
    } catch (cause) {
        throw new MortyValidationError("The harness and native Session identity are invalid", { cause });
    }
    const suffix = query === undefined || query.size === 0 ? "" : `?${query.toString()}`;
    return {
        computerId,
        method,
        path: `v1/computers/${encodeURIComponent(computerId)}/harnesses/${encodeURIComponent(parsed.harness)}/sessions/${encodeURIComponent(parsed.sessionId)}/${resource}${suffix}`,
        transport,
        timeoutMilliseconds,
        encrypted,
    };
}

export const sessionEndpoints = Object.freeze({
    readConfiguration: ({ computerId, target }: SessionCallTarget): MortyEndpointCall =>
        endpoint({
            computerId,
            target,
            method: "GET",
            resource: "configuration",
            encrypted: {
                request: [sessionConfigReadCommandCodec],
                response: [sessionConfigReadResultCodec, sessionOperationFailedEventCodec],
            },
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
    updateConfiguration: ({ computerId, target }: SessionCallTarget): MortyEndpointCall =>
        endpoint({
            computerId,
            target,
            method: "POST",
            resource: "configuration",
            encrypted: {
                request: [sessionConfigureCommandCodec],
                response: [sessionConfigUpdatedEventCodec, sessionOperationFailedEventCodec],
            },
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
    rename: ({ computerId, target }: SessionCallTarget): MortyEndpointCall =>
        endpoint({
            computerId,
            target,
            method: "POST",
            resource: "rename",
            encrypted: {
                request: [sessionRenameCommandCodec],
                response: [sessionRenamedEventCodec, sessionOperationFailedEventCodec],
            },
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
    readFile: ({
        computerId,
        target,
        path,
        maximumBytes,
    }: SessionCallTarget & { readonly path: string; readonly maximumBytes: number }): MortyEndpointCall =>
        endpoint({
            computerId,
            target,
            method: "GET",
            resource: "files/content",
            encrypted: {
                request: [fileReadCommandCodec],
                response: [
                    fileBeginEventCodec,
                    fileEndEventCodec,
                    fileFailedEventCodec,
                    sessionOperationFailedEventCodec,
                ],
            },
            transport: { kind: "http" },
            timeoutMilliseconds: 20_000,
            query: new URLSearchParams({ maxBytes: maximumBytes.toString(), path }),
        }),
    readExecution: ({
        computerId,
        target,
        commandId,
    }: SessionCallTarget & { readonly commandId?: string }): MortyEndpointCall =>
        endpoint({
            computerId,
            target,
            method: "GET",
            resource: "active-turn",
            encrypted: {
                request: [nativeSessionRequestCodec],
                response: [nativeSessionResultCodec, sessionOperationFailedEventCodec],
            },
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
            query: new URLSearchParams(commandId === undefined ? {} : { commandId }),
        }),
    submitTurn: ({ computerId, target }: SessionCallTarget): MortyEndpointCall =>
        endpoint({
            computerId,
            target,
            method: "POST",
            resource: "turns",
            encrypted: {
                request: [sessionPromptCommandCodec],
                response: [sessionPromptAcceptedEventCodec, sessionOperationFailedEventCodec],
            },
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
    liveEvents: ({ computerId, target }: SessionCallTarget): MortyEndpointCall =>
        endpoint({
            computerId,
            target,
            method: "GET",
            resource: "events",
            encrypted: {
                request: [sessionEventsSubscribeCommandCodec],
                response: [sessionCloseNoticeEventCodec, sessionEventEnvelopeCodec, sessionOperationFailedEventCodec],
            },
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 15_000,
        }),
    listEvents: ({
        computerId,
        target,
    }: SessionCallTarget & { readonly limit: number; readonly cursor: string }): MortyEndpointCall =>
        endpoint({
            computerId,
            target,
            method: "GET",
            resource: "events",
            encrypted: {
                request: [sessionHistoryPageLoadCodec],
                response: [sessionHistoryPageLoadedCodec, sessionOperationFailedEventCodec],
            },
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
    uploadContent: ({
        computerId,
        target,
        key,
    }: SessionCallTarget & { readonly key: string; readonly uri: string }): MortyEndpointCall =>
        endpoint({
            computerId,
            target,
            method: "PUT",
            resource: `content/${encodeURIComponent(key)}`,
            encrypted: {
                request: [contentCommitCommandCodec, contentWriteCommandCodec],
                response: [
                    contentReadyEventCodec,
                    contentAvailableEventCodec,
                    fileFailedEventCodec,
                    sessionOperationFailedEventCodec,
                ],
            },
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
    cancelTurn: ({ computerId, target, turnId }: SessionCallTarget & { readonly turnId: string }): MortyEndpointCall =>
        endpoint({
            computerId,
            target,
            method: "POST",
            resource: `turns/${encodeURIComponent(turnId)}/cancel`,
            encrypted: {
                request: [sessionCancelCommandCodec],
                response: [sessionTurnStoppedEventCodec, sessionOperationFailedEventCodec],
            },
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
    cancelQueuedTurn: ({
        computerId,
        target,
        turnId,
    }: SessionCallTarget & { readonly turnId: string }): MortyEndpointCall =>
        endpoint({
            computerId,
            target,
            method: "POST",
            resource: `turns/${encodeURIComponent(turnId)}/cancel-before-start`,
            encrypted: {
                request: [sessionCancelBeforeStartCommandCodec],
                response: [sessionTurnWithdrawnEventCodec, sessionOperationFailedEventCodec],
            },
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
    steerTurn: ({ computerId, target, turnId }: SessionCallTarget & { readonly turnId: string }): MortyEndpointCall =>
        endpoint({
            computerId,
            target,
            method: "PUT",
            resource: `turns/${encodeURIComponent(turnId)}/disposition`,
            encrypted: {
                request: [sessionPromptDispositionCommandCodec],
                response: [sessionPromptSteeredEventCodec, sessionOperationFailedEventCodec],
            },
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
    respond: ({
        computerId,
        target,
        interactionId,
    }: SessionCallTarget & { readonly interactionId: string }): MortyEndpointCall =>
        endpoint({
            computerId,
            target,
            method: "POST",
            resource: `interactions/${encodeURIComponent(interactionId)}/responses`,
            encrypted: {
                request: [sessionPermissionRespondCommandCodec, sessionElicitationRespondCommandCodec],
                response: [sessionInteractionAnsweredEventCodec, sessionOperationFailedEventCodec],
            },
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
});
