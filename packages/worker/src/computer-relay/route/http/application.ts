import { MORTY_API_PREFIX } from "@morty-build/client/protocol";
import { Hono } from "hono";
import type { WebSocketHttpDispatch } from "../../../contracts/websocket-http-dispatch.ts";
import { errorHandler, errorMiddleware } from "../../../http/error-middleware.ts";
import { createAgentSetupRoutes } from "../../components/chat/route/bot-chat-routes.ts";
import { createTransferRedemptionRoutes } from "../../components/management/route/authentication-routes.ts";
import { createComputerPairingRoutes } from "../../components/management/route/http/computer-pairing-routes.ts";
import { createComputerRoutes } from "../../components/management/route/http/computer-routes.ts";
import { createDaemonConnectionRoutes } from "../../components/management/route/http/daemon-connection-routes.ts";
import { createManagementApplication } from "../../components/management/route/index.ts";
import type { ComputerRouteContext } from "../../composition/computer-route-context.ts";
import { managementRouteContext } from "../management-route-context.ts";
import { createComputerConnectionRoutes } from "./connection-routes.ts";
import type { ComputerRouteHttpEnvironment } from "./environment.ts";
import { createComputerFileRoutes } from "./file-routes.ts";
import { createComputerInternalRoutes } from "./internal-routes.ts";

export function createComputerHttpApplication(ctx: ComputerRouteContext, dispatch: WebSocketHttpDispatch) {
    const management = managementRouteContext(ctx);
    const protocol = { services: { forComputer: ctx.services.relay } };
    const computer = new Hono<ComputerRouteHttpEnvironment>()
        .route("/", createComputerPairingRoutes(protocol))
        .route("/", createComputerRoutes(protocol))
        .route("/", createComputerConnectionRoutes(ctx, dispatch))
        .route("/harnesses", createComputerFileRoutes(ctx))
        .route("/", createManagementApplication(management).route("/", createAgentSetupRoutes(management)));
    const computers = new Hono<ComputerRouteHttpEnvironment>()
        .route("/", createDaemonConnectionRoutes(protocol))
        .route("/:computerId", computer);
    const v1 = new Hono<ComputerRouteHttpEnvironment>()
        .route("/computers", computers)
        .route("/", createTransferRedemptionRoutes(management));
    return new Hono<ComputerRouteHttpEnvironment>()
        .onError(errorHandler)
        .use("*", errorMiddleware)
        .route("/", createComputerInternalRoutes(ctx))
        .route(MORTY_API_PREFIX, new Hono<ComputerRouteHttpEnvironment>().route("/v1", v1))
        .notFound(() =>
            Response.json(
                { error: { code: "not_found", message: "The requested Morty resource does not exist" } },
                { status: 404 },
            ),
        );
}
