import { decodeNativeSessionTarget, isIdentifier, type NativeSessionTarget } from "@morty-build/client/protocol";
import { MortyValidationError } from "../errors.ts";
import type { MortyTransportEndpoint, MortyTransportPolicy } from "./call.ts";

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
    readonly method: MortyTransportEndpoint["method"];
    readonly resource: string;
    readonly transport: MortyTransportPolicy;
    readonly timeoutMilliseconds: number;
    readonly query?: URLSearchParams;
}): MortyTransportEndpoint {
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
    };
}

export const sessionEndpoints = Object.freeze({
    readConfiguration: ({ computerId, target }: SessionCallTarget): MortyTransportEndpoint =>
        endpoint({
            computerId,
            target,
            method: "GET",
            resource: "configuration",
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
    updateConfiguration: ({ computerId, target }: SessionCallTarget): MortyTransportEndpoint =>
        endpoint({
            computerId,
            target,
            method: "POST",
            resource: "configuration",
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
    rename: ({ computerId, target }: SessionCallTarget): MortyTransportEndpoint =>
        endpoint({
            computerId,
            target,
            method: "POST",
            resource: "rename",
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
    readFile: ({ computerId, target }: SessionCallTarget): MortyTransportEndpoint =>
        endpoint({
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
    }: SessionCallTarget & { readonly commandId?: string }): MortyTransportEndpoint =>
        endpoint({
            computerId,
            target,
            method: "GET",
            resource: "active-turn",
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
            query: new URLSearchParams(commandId === undefined ? {} : { commandId }),
        }),
    submitTurn: ({ computerId, target }: SessionCallTarget): MortyTransportEndpoint =>
        endpoint({
            computerId,
            target,
            method: "POST",
            resource: "turns",
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
    liveEvents: ({ computerId, target }: SessionCallTarget): MortyTransportEndpoint =>
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
    }: SessionCallTarget & { readonly limit: number; readonly cursor: string }): MortyTransportEndpoint =>
        endpoint({
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
    }: SessionCallTarget & { readonly key: string; readonly uri: string }): MortyTransportEndpoint =>
        endpoint({
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
        turnId,
    }: SessionCallTarget & { readonly turnId: string }): MortyTransportEndpoint =>
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
    }: SessionCallTarget & { readonly turnId: string }): MortyTransportEndpoint =>
        endpoint({
            computerId,
            target,
            method: "POST",
            resource: `turns/${encodeURIComponent(turnId)}/cancel-before-start`,
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
    steerTurn: ({
        computerId,
        target,
        turnId,
    }: SessionCallTarget & { readonly turnId: string }): MortyTransportEndpoint =>
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
    }: SessionCallTarget & { readonly interactionId: string }): MortyTransportEndpoint =>
        endpoint({
            computerId,
            target,
            method: "POST",
            resource: `interactions/${encodeURIComponent(interactionId)}/responses`,
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 20_000,
        }),
});
