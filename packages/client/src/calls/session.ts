import { isIdentifier, type NativeSessionTarget } from "@morty-build/client/protocol";
import { MortyValidationError } from "../errors.ts";
import { nativeSessionTargetSchema } from "../protocol/session/shared/native-session-target.ts";
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
}: SessionCallTarget & {
    readonly method: MortyEndpointCall["method"];
    readonly resource: string;
    readonly transport: MortyTransportPolicy;
    readonly timeoutMilliseconds: number;
    readonly query?: URLSearchParams;
}): MortyEndpointCall {
    if (!isIdentifier(computerId)) {
        throw new MortyValidationError("The Morty Computer identifier is invalid");
    }
    const parsed = nativeSessionTargetSchema.safeParse(target);
    if (!parsed.success) {
        throw new MortyValidationError("The harness and native Session identity are invalid", { cause: parsed.error });
    }
    const suffix = query === undefined || query.size === 0 ? "" : `?${query.toString()}`;
    return {
        computerId,
        method,
        path: `v1/computers/${encodeURIComponent(computerId)}/harnesses/${encodeURIComponent(parsed.data.harness)}/sessions/${encodeURIComponent(parsed.data.sessionId)}/${resource}${suffix}`,
        transport,
        timeoutMilliseconds,
    };
}

export const sessionEndpoints = Object.freeze({
    readConfiguration: ({ computerId, target }: SessionCallTarget): MortyEndpointCall =>
        endpoint({
            computerId,
            target,
            method: "GET",
            resource: "configuration",
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
    updateConfiguration: ({ computerId, target }: SessionCallTarget): MortyEndpointCall =>
        endpoint({
            computerId,
            target,
            method: "POST",
            resource: "configuration",
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
    rename: ({ computerId, target }: SessionCallTarget): MortyEndpointCall =>
        endpoint({
            computerId,
            target,
            method: "POST",
            resource: "rename",
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
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
    liveEvents: ({ computerId, target }: SessionCallTarget): MortyEndpointCall =>
        endpoint({
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
        limit,
        cursor,
    }: SessionCallTarget & { readonly limit: number; readonly cursor: string }): MortyEndpointCall =>
        endpoint({
            computerId,
            target,
            method: "GET",
            resource: "events",
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
            query: new URLSearchParams({ limit: limit.toString(), ...(cursor.length === 0 ? {} : { cursor }) }),
        }),
    uploadContent: ({
        computerId,
        target,
        key,
        uri,
    }: SessionCallTarget & { readonly key: string; readonly uri: string }): MortyEndpointCall =>
        endpoint({
            computerId,
            target,
            method: "PUT",
            resource: `content/${encodeURIComponent(key)}`,
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
            query: new URLSearchParams({ uri }),
        }),
    cancelTurn: ({ computerId, target, turnId }: SessionCallTarget & { readonly turnId: string }): MortyEndpointCall =>
        endpoint({
            computerId,
            target,
            method: "POST",
            resource: `turns/${encodeURIComponent(turnId)}/cancel`,
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
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
    steerTurn: ({ computerId, target, turnId }: SessionCallTarget & { readonly turnId: string }): MortyEndpointCall =>
        endpoint({
            computerId,
            target,
            method: "PUT",
            resource: `turns/${encodeURIComponent(turnId)}/disposition`,
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
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
});
