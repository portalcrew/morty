import { Hono } from "hono";
import { ManagementError } from "../../../../contracts/management-error.ts";
import { computerFromPath } from "../../../../http/computer-target.ts";
import { controlBodyLimit } from "../../../../http/control-body-limit.ts";
import { errorHandler } from "../../../../http/error-middleware.ts";
import { requestTimeoutMiddleware } from "../../../../middleware/request-timeout-middleware.ts";
import { createBotChatRoutes } from "../../chat/http/bot-chat-routes.ts";
import { createAuthenticationRoutes } from "./authentication-routes.ts";
import { createComputerManagementRoutes } from "./computer-management-routes.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";
import type { ManagementRouteContext } from "./route-context.ts";

export function createManagementApplication(ctx: ManagementRouteContext) {
    return new Hono<ManagementHttpEnvironment>()
        .onError(errorHandler)
        .use("*", requestTimeoutMiddleware<ManagementHttpEnvironment>(30_000), computerFromPath, controlBodyLimit)
        .notFound(() => {
            throw new ManagementError("NOT_FOUND", "Not found.", 404);
        })
        .route("/", createBotChatRoutes(ctx))
        .route("/", createAuthenticationRoutes(ctx))
        .route("/", createComputerManagementRoutes(ctx));
}
