import { decodeNativeSessionTarget, isIdentifier, type NativeSessionTarget } from "@portalcrew/morty-client/protocol";
import { MortyValidationError } from "../errors.ts";
import type { MortyOperationEndpoint, MortyTransportEndpoint, MortyTransportPolicy } from "./call.ts";

export interface SessionCallTarget {
    readonly computerId: string;
    readonly target: NativeSessionTarget;
}

function endpoint({
    computerId,
    target,
    operation,
    method,
    resource,
    transport,
    timeoutMilliseconds,
    query,
}: SessionCallTarget & {
    readonly operation: string;
    readonly method: MortyTransportEndpoint["method"];
    readonly resource: string;
    readonly transport: MortyTransportPolicy;
    readonly timeoutMilliseconds: number;
    readonly query?: URLSearchParams;
}): MortyOperationEndpoint {
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
        operation,
        method,
        path: `v1/computers/${encodeURIComponent(computerId)}/harnesses/${encodeURIComponent(parsed.harness)}/sessions/${encodeURIComponent(parsed.sessionId)}/${resource}${suffix}`,
        transport,
        timeoutMilliseconds,
    };
}

export const sessionEndpoints = Object.freeze({
    readConfiguration: ({ computerId, target }: SessionCallTarget): MortyOperationEndpoint =>
        endpoint({
            operation: "session-configuration-read",
            computerId,
            target,
            method: "GET",
            resource: "configuration",
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
    updateConfiguration: ({ computerId, target }: SessionCallTarget): MortyOperationEndpoint =>
        endpoint({
            operation: "session-configuration-update",
            computerId,
            target,
            method: "POST",
            resource: "configuration",
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
    rename: ({ computerId, target }: SessionCallTarget): MortyOperationEndpoint =>
        endpoint({
            operation: "session-rename",
            computerId,
            target,
            method: "POST",
            resource: "rename",
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
    readFile: ({ computerId, target }: SessionCallTarget): MortyOperationEndpoint =>
        endpoint({
            operation: "session-file-read",
            computerId,
            target,
            method: "POST",
            resource: "files/content",
            transport: { kind: "http" },
            timeoutMilliseconds: 20_000,
        }),
    readExecution: ({
        computerId,
        target,
        commandId,
    }: SessionCallTarget & { readonly commandId?: string }): MortyOperationEndpoint =>
        endpoint({
            operation: "session-active-turn",
            computerId,
            target,
            method: "GET",
            resource: "active-turn",
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
            query: new URLSearchParams(commandId === undefined ? {} : { commandId }),
        }),
    submitTurn: ({ computerId, target }: SessionCallTarget): MortyOperationEndpoint =>
        endpoint({
            operation: "session-turn-submit",
            computerId,
            target,
            method: "POST",
            resource: "turns",
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
    liveEvents: ({ computerId, target }: SessionCallTarget): MortyOperationEndpoint =>
        endpoint({
            operation: "session-events-live",
            computerId,
            target,
            method: "GET",
            resource: "events",
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 15_000,
        }),
    listEvents: ({
        computerId,
        target,
    }: SessionCallTarget & { readonly limit: number; readonly cursor: string }): MortyOperationEndpoint =>
        endpoint({
            operation: "session-events-list",
            computerId,
            target,
            method: "GET",
            resource: "events",
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
    uploadContent: ({
        computerId,
        target,
        key,
    }: SessionCallTarget & { readonly key: string; readonly uri: string }): MortyOperationEndpoint =>
        endpoint({
            operation: "session-content-upload",
            computerId,
            target,
            method: "PUT",
            resource: `content/${encodeURIComponent(key)}`,
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 120_000,
        }),
    cancelTurn: ({
        computerId,
        target,
        commandId,
    }: SessionCallTarget & { readonly commandId: string }): MortyOperationEndpoint =>
        endpoint({
            operation: "session-turn-cancel",
            computerId,
            target,
            method: "POST",
            resource: `turns/${encodeURIComponent(commandId)}/cancel`,
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
    cancelQueuedTurn: ({
        computerId,
        target,
        commandId,
    }: SessionCallTarget & { readonly commandId: string }): MortyOperationEndpoint =>
        endpoint({
            operation: "session-turn-cancel-queued",
            computerId,
            target,
            method: "POST",
            resource: `turns/${encodeURIComponent(commandId)}/cancel-before-start`,
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
    steerTurn: ({
        computerId,
        target,
        commandId,
    }: SessionCallTarget & { readonly commandId: string }): MortyOperationEndpoint =>
        endpoint({
            operation: "session-turn-steer",
            computerId,
            target,
            method: "PUT",
            resource: `turns/${encodeURIComponent(commandId)}/disposition`,
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
    respond: ({
        computerId,
        target,
        interactionId,
    }: SessionCallTarget & { readonly interactionId: string }): MortyOperationEndpoint =>
        endpoint({
            operation: "session-interaction-respond",
            computerId,
            target,
            method: "POST",
            resource: `interactions/${encodeURIComponent(interactionId)}/responses`,
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
});
