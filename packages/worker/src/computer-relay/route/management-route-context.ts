import { RequestDeadline } from "../../http/request-deadline.ts";
import type { ManagementRouteContext } from "../components/management/route/route-context.ts";
import type { ComputerRouteContext } from "../composition/computer-route-context.ts";

export function managementRouteContext(ctx: ComputerRouteContext): ManagementRouteContext {
    return {
        services: {
            forComputer: async (computerId, signal) => {
                using deadline = new RequestDeadline(signal, 20_000);
                return await ctx.services.browser.forComputer(computerId, ctx.bindings, deadline.signal);
            },
        },
    };
}
