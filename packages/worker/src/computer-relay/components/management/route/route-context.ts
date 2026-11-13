import type { Context } from "hono";
import type { ApplicationContext } from "../../../composition/application-context.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";

export interface ManagementRouteContext {
    readonly services: {
        readonly forComputer: (computerId: string, signal: AbortSignal) => Promise<ApplicationContext>;
    };
}

/** Resolve dependencies explicitly at the operation boundary, never through Hono variables. */
export async function applicationForRequest<E extends ManagementHttpEnvironment>(
    ctx: ManagementRouteContext,
    context: Context<E>,
    signal = context.req.raw.signal,
): Promise<ApplicationContext> {
    return await ctx.services.forComputer(context.var.computerId, signal);
}
