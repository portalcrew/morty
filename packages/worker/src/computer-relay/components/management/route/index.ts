import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ManagementError } from "../../../../contracts/management-error.ts";
import { computerFromPath } from "../../../../http/computer-target.ts";
import { requestTimeoutMiddleware } from "../../../../middleware/request-timeout-middleware.ts";
import { createBotChatRoutes } from "../../chat/route/bot-chat-routes.ts";
import { createAuthenticationRoutes } from "./authentication-routes.ts";
import { createComputerManagementRoutes } from "./computer-management-routes.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";
import type { ManagementRouteContext } from "./route-context.ts";

export function createManagementApplication(ctx: ManagementRouteContext) {
    return new Hono<ManagementHttpEnvironment>()
        .use(
            "*",
            requestTimeoutMiddleware<ManagementHttpEnvironment>(30_000),
            computerFromPath,
            bodyLimit({ maxSize: 3 * 1_024 * 1_024 }),
        )
        .notFound(() => {
            throw new ManagementError("NOT_FOUND", "Not found.", 404);
        })
        .route("/", createBotChatRoutes(ctx))
        .route("/", createAuthenticationRoutes(ctx))
        .route("/", createComputerManagementRoutes(ctx));
}
