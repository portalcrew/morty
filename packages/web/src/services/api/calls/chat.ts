import type { ApiRequest, ComputerCallTarget } from "./call.ts";
import { encodeComputerCall } from "./encode-call.ts";

export const chatCalls = Object.freeze({
    computerConfiguration: ({ origin, computerId }: ComputerCallTarget): ApiRequest =>
        encodeComputerCall({
            origin,
            computerId,
            path: "workspace",
            definition: {
                method: "POST",
                operation: "workspace",
                transport: { kind: "websocket", cancellation: "remote" },
                timeoutMilliseconds: 45_000,
                watch: "snapshot",
            },
        }),
});
