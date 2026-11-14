import { MORTY_API_PREFIX } from "@morty-build/client/protocol";
import { Hono } from "hono";
import { rethrowHonoError } from "../../../../http/error-middleware.ts";
import type { RelayContext } from "../../../composition/relay-services.ts";
import type { ComputerRouteHttpEnvironment } from "../../../http/environment.ts";
import { createComputerPairingRoutes } from "./computer-pairing-routes.ts";
import { createComputerRoutes } from "./computer-routes.ts";

export interface RelayProtocolRouteContext {
    readonly services: { readonly forComputer: (computerId: string) => RelayContext };
}

export function createRelayProtocolRoutes(ctx: RelayProtocolRouteContext) {
    return new Hono<ComputerRouteHttpEnvironment>()
        .basePath(MORTY_API_PREFIX)
        .onError(rethrowHonoError)
        .route("/v1", createComputerPairingRoutes(ctx))
        .route("/v1/computers", createComputerRoutes(ctx));
}
