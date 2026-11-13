import type { ApiRequest, ComputerCallTarget, WorkerCallTarget } from "./call.ts";
import { encodeIdentityCall, encodeWorkerCall } from "./encode-call.ts";

export const identityCalls = Object.freeze({
    session: ({ origin, computerId }: ComputerCallTarget): ApiRequest =>
        encodeIdentityCall({
            origin,
            computerId,
            path: "session",
            definition: {
                method: "GET",
                operation: "session",
                timeoutMilliseconds: 30_000,
                watch: "none",
                transport: { kind: "websocket", cancellation: "remote" },
            },
        }),
    createTransfer: ({
        origin,
        computerId,
        operationId,
        accessDuration,
        replaces,
    }: ComputerCallTarget & {
        readonly operationId: string;
        readonly accessDuration: "1h" | "1d" | "7d" | "30d" | null;
        readonly replaces: string | null;
    }): ApiRequest =>
        encodeIdentityCall({
            origin,
            computerId,
            path: "identity/transfers",
            definition: {
                method: "POST",
                operation: "transfers",
                timeoutMilliseconds: 30_000,
                watch: "none",
                transport: { kind: "websocket", cancellation: "remote" },
            },
            body: {
                operationId,
                ...(accessDuration === null ? {} : { accessDuration }),
                ...(replaces === null ? {} : { replaces }),
            },
        }),
    redeemTransfer: ({
        origin,
        computerId,
        code,
        replaces,
        device,
        redemptionKey,
    }: WorkerCallTarget & {
        readonly code: string;
        readonly replaces: string | null;
        readonly device: string;
        readonly redemptionKey: string;
    }): ApiRequest =>
        encodeWorkerCall({
            origin,
            computerId,
            path: "identity/transfers/redeem",
            definition: {
                method: "POST",
                operation: "redeem",
                timeoutMilliseconds: 30_000,
                watch: "none",
                transport: { kind: "http" },
            },
            body: {
                code,
                ...(replaces === null ? {} : { replaces }),
                device,
                redemptionKey,
            },
        }),
    linkedDevices: ({ origin, computerId }: ComputerCallTarget): ApiRequest =>
        encodeIdentityCall({
            origin,
            computerId,
            path: "identity/devices",
            definition: {
                method: "GET",
                operation: "devices",
                timeoutMilliseconds: 30_000,
                watch: "snapshot",
                transport: { kind: "websocket", cancellation: "remote" },
            },
        }),
    endOtherBrowserAccess: ({ origin, computerId }: ComputerCallTarget): ApiRequest =>
        encodeIdentityCall({
            origin,
            computerId,
            path: "identity/other-browser-access",
            definition: {
                method: "DELETE",
                operation: "other-browser-access",
                timeoutMilliseconds: 30_000,
                watch: "none",
                transport: { kind: "websocket", cancellation: "remote" },
            },
        }),
    endDeviceAccess: ({
        origin,
        computerId,
        deviceId,
    }: ComputerCallTarget & { readonly deviceId: string }): ApiRequest =>
        encodeIdentityCall({
            origin,
            computerId,
            path: `identity/devices/${encodeURIComponent(deviceId)}`,
            definition: {
                method: "DELETE",
                operation: "end-device-access",
                timeoutMilliseconds: 30_000,
                watch: "none",
                transport: { kind: "websocket", cancellation: "remote" },
            },
        }),
    endLocalCredential: ({ origin, computerId }: ComputerCallTarget): ApiRequest =>
        encodeIdentityCall({
            origin,
            computerId,
            path: "identity/local-credential",
            definition: {
                method: "DELETE",
                operation: "local-credential",
                timeoutMilliseconds: 30_000,
                watch: "none",
                transport: { kind: "websocket", cancellation: "remote" },
            },
        }),
    endBrowserAccess: ({ origin, computerId }: ComputerCallTarget): ApiRequest =>
        encodeIdentityCall({
            origin,
            computerId,
            path: "identity/browser-access",
            definition: {
                method: "DELETE",
                operation: "browser-access",
                timeoutMilliseconds: 30_000,
                watch: "none",
                transport: { kind: "websocket", cancellation: "remote" },
            },
        }),
});
