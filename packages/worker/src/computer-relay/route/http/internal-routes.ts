import { Hono, type MiddlewareHandler } from "hono";
import { ComputerManagementError } from "../../../contracts/computer-management.ts";
import { COMPUTER_INTERNAL_PREFIX } from "../../../contracts/computer-relay-http.ts";
import { computerFromPath } from "../../../http/computer-target.ts";
import { json } from "../../../http/json.ts";
import { RequestDeadline } from "../../../http/request-deadline.ts";
import { requestTimeoutMiddleware } from "../../../middleware/request-timeout-middleware.ts";
import type { ComputerRouteContext } from "../../composition/computer-route-context.ts";
import type { ComputerRouteHttpEnvironment } from "./environment.ts";

export function createComputerInternalRoutes(ctx: ComputerRouteContext) {
    const authorizeTarget: MiddlewareHandler<ComputerRouteHttpEnvironment> = async (context, next) => {
        if (!ctx.ownsComputer(context.var.computerId)) {
            throw new ComputerManagementError("computer_id_mismatch", "The computer is unavailable", 421);
        }
        await next();
    };
    return new Hono<ComputerRouteHttpEnvironment>()
        .route(
            COMPUTER_INTERNAL_PREFIX,
            new Hono<ComputerRouteHttpEnvironment>().post(
                "/:computerId/account",
                requestTimeoutMiddleware<ComputerRouteHttpEnvironment>(30_000),
                computerFromPath,
                authorizeTarget,
                async (context) => {
                    const computerId = context.var.computerId;
                    await ctx.services.accounts.create(context.req.raw.signal);
                    return context.json({ computerId });
                },
            ),
        )
        .post("/__computer/bootstrap", async (context) => {
            using deadline = new RequestDeadline(context.req.raw.signal, 45_000);
            const input: unknown = await context.req.json();
            return json(await ctx.services.browser.bootstrap(input, ctx.bindings, deadline.signal), 201);
        });
}
