import type { ApiRequest, ComputerCallTarget } from "./call.ts";
import { encodeComputerCall } from "./encode-call.ts";

export const managementCalls = Object.freeze({
    readComputer: ({ origin, computerId }: ComputerCallTarget): ApiRequest =>
        encodeComputerCall({
            origin,
            computerId,
            path: `computers/${encodeURIComponent(computerId)}`,
            definition: {
                method: "GET",
                operation: "computer",
                transport: { kind: "websocket", cancellation: "remote" },
                timeoutMilliseconds: 15_000,
                watch: "none",
            },
        }),
    readComputerPairing: ({ origin, computerId }: ComputerCallTarget): ApiRequest =>
        encodeComputerCall({
            origin,
            computerId,
            path: `computers/${encodeURIComponent(computerId)}/pairing-state`,
            definition: {
                method: "GET",
                operation: "pairing-state",
                transport: { kind: "websocket", cancellation: "remote" },
                timeoutMilliseconds: 15_000,
                watch: "snapshot",
            },
        }),
});
