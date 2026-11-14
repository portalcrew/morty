import type { MiddlewareHandler } from "hono";
import type { ComputerRouteHttpEnvironment } from "../computer-relay/http/environment.ts";
import { PairingDirectoryError } from "../contracts/relay/pairing.ts";
import { requestTimeoutMiddleware } from "./request-timeout-middleware.ts";

export function pairingTimeoutMiddleware(message: string): MiddlewareHandler<ComputerRouteHttpEnvironment> {
    return requestTimeoutMiddleware<ComputerRouteHttpEnvironment>(
        15_000,
        (cause) => new PairingDirectoryError("pairing_timeout", message, { cause }),
    );
}
