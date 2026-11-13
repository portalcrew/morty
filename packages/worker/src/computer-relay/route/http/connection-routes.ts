import { Hono, type MiddlewareHandler } from "hono";
import { ComputerManagementError } from "../../../contracts/computer-management.ts";
import type { WebSocketHttpDispatch } from "../../../contracts/websocket-http-dispatch.ts";
import { computerFromPath } from "../../../http/computer-target.ts";
import { errorHandler, errorMiddleware } from "../../../http/error-middleware.ts";
import { requestTimeoutMiddleware } from "../../../middleware/request-timeout-middleware.ts";
import { acceptWebSocketHttpTransport } from "../../components/runtime/service/websocket-http-transport.ts";
import type { ComputerRouteContext } from "../../composition/computer-route-context.ts";
import type { ComputerRouteHttpEnvironment } from "./environment.ts";

/** Browser WebSocket upgrade handshake, dispatched through the HTTP fetch entrypoint. */
export function createComputerConnectionRoutes(ctx: ComputerRouteContext, dispatch: WebSocketHttpDispatch) {
    const authorizeTarget: MiddlewareHandler<ComputerRouteHttpEnvironment> = async (context, next) => {
        if (!ctx.ownsComputer(context.var.computerId)) {
            throw new ComputerManagementError("computer_id_mismatch", "The computer is unavailable", 421);
        }
        await next();
    };
    return new Hono<ComputerRouteHttpEnvironment>()
        .onError(errorHandler)
        .use("*", errorMiddleware)
        .get(
            "/transport",
            requestTimeoutMiddleware<ComputerRouteHttpEnvironment>(30_000),
            computerFromPath,
            authorizeTarget,
            (context) => acceptWebSocketHttpTransport({ request: context.req.raw, dispatch }),
        );
}
