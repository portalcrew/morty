import type { Context } from "hono";
import type { ApplicationContext } from "../../../composition/application-context.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";

export interface ManagementRouteContext {
    readonly services: {
        readonly forComputer: (computerId: string) => ApplicationContext;
    };
}

/** Resolve dependencies explicitly at the operation boundary, never through Hono variables. */
export function applicationForRequest<E extends ManagementHttpEnvironment>(
    ctx: ManagementRouteContext,
    context: Context<E>,
): ApplicationContext {
    return ctx.services.forComputer(context.var.computerId);
}
