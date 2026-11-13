import { COMPUTER_SUCCESSOR_CREDENTIAL_HEADER } from "@morty-build/client/protocol";
import { Hono } from "hono";
import * as v from "valibot";
import { validateAgents, validateIdentifier } from "../../../../../contracts/relay/pairing.ts";
import { bearerToken } from "../../../../../http/bearer-token.ts";
import { bodyParser } from "../../../../../http/body-parser.ts";
import { computerFromPath } from "../../../../../http/computer-target.ts";
import { errorMiddleware, rethrowHonoError } from "../../../../../http/error-middleware.ts";
import { protocolBodyLimit } from "../../../../../http/protocol-body-limit.ts";
import { requestTimeoutMiddleware } from "../../../../../middleware/request-timeout-middleware.ts";
import type { RelayProtocolEnvironment as RelayHttpEnvironment } from "../../../../route/http/environment.ts";
import type { RelayProtocolRouteContext } from "../relay-protocol-route-context.ts";

// validateAgents decodes the catalog and reports its own error code.
const catalogRequestSchema = v.object({ agents: v.unknown() });

export function createComputerRoutes(ctx: RelayProtocolRouteContext) {
    return new Hono<RelayHttpEnvironment>()
        .onError(rethrowHonoError)
        .use("*", errorMiddleware)
        .put(
            "/catalog",
            requestTimeoutMiddleware<RelayHttpEnvironment>(30_000),
            computerFromPath,
            protocolBodyLimit,
            bodyParser<RelayHttpEnvironment, typeof catalogRequestSchema>(catalogRequestSchema),
            async (context) => {
                const useCases = ctx.services.forComputer(context.var.computerId).services.computerConnections;
                const body = context.req.valid("json");
                const agents = validateAgents(body.agents);
                await useCases.updateAgentCatalog(
                    validateIdentifier(context.var.computerId, "computer_id"),
                    bearerToken(context.req.raw),
                    context.req.header(COMPUTER_SUCCESSOR_CREDENTIAL_HEADER) ?? null,
                    agents,
                    context.req.raw.signal,
                );
                return new Response(null, { status: 204 });
            },
        );
}
