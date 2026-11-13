import type { MiddlewareHandler } from "hono";
import type { RelayProtocolEnvironment as RelayHttpEnvironment } from "../computer-relay/route/http/environment.ts";
import { PairingDirectoryError } from "../contracts/relay/pairing.ts";
import { requestTimeoutMiddleware } from "./request-timeout-middleware.ts";

export function pairingTimeoutMiddleware(message: string): MiddlewareHandler<RelayHttpEnvironment> {
    return requestTimeoutMiddleware<RelayHttpEnvironment>(
        15_000,
        (cause) => new PairingDirectoryError("pairing_timeout", message, { cause }),
    );
}
