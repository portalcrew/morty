import { Hono } from "hono";
import * as v from "valibot";
import {
    validateAgents,
    validateDisplayName,
    validateIdentifier,
    validatePairingCode,
} from "../../../../../contracts/relay/pairing.ts";
import { bodyParser } from "../../../../../http/body-parser.ts";
import { computerFromPath } from "../../../../../http/computer-target.ts";
import { errorMiddleware, rethrowHonoError } from "../../../../../http/error-middleware.ts";
import { protocolBodyLimit } from "../../../../../http/protocol-body-limit.ts";
import { pairingTimeoutMiddleware } from "../../../../../middleware/pairing-timeout-middleware.ts";
import { requestTimeoutMiddleware } from "../../../../../middleware/request-timeout-middleware.ts";
import type { RelayProtocolEnvironment as RelayHttpEnvironment } from "../../../../route/http/environment.ts";
import type { RelayProtocolRouteContext } from "../relay-protocol-route-context.ts";

// The validators below decode each field into its domain value and report its own error code.
const redeemRequestSchema = v.object({
    agents: v.unknown(),
    computerName: v.unknown(),
    pairingCode: v.unknown(),
    workspaceName: v.unknown(),
});

export function createComputerPairingRoutes(ctx: RelayProtocolRouteContext) {
    const timeout = requestTimeoutMiddleware<RelayHttpEnvironment>(30_000);
    return new Hono<RelayHttpEnvironment>()
        .onError(rethrowHonoError)
        .use("*", errorMiddleware)
        .post(
            "/pairing/redeem",
            timeout,
            computerFromPath,
            pairingTimeoutMiddleware("Computer pairing redemption timed out"),
            protocolBodyLimit,
            bodyParser<RelayHttpEnvironment, typeof redeemRequestSchema>(redeemRequestSchema),
            async (context) => {
                const body = context.req.valid("json");
                const agents = validateAgents(body.agents);
                const services = ctx.services.forComputer(context.var.computerId).services;
                const redeemed = await services.computerPairings.redeemComputerPairing(
                    validateIdentifier(context.var.computerId, "computer_id"),
                    validatePairingCode(body.pairingCode),
                    validateDisplayName(body.computerName, "computer_name"),
                    validateDisplayName(body.workspaceName, "workspace_name"),
                    agents,
                    context.var.signal,
                );
                return context.json({
                    computerId: redeemed.computerId,
                    computerCredential: redeemed.daemonToken,
                });
            },
        );
}
