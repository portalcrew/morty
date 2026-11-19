import { COMPUTER_SUCCESSOR_CREDENTIAL_HEADER } from "@portalcrew/morty-client/protocol";
import { Hono } from "hono";
import * as v from "valibot";
import {
    validateAgents,
    validateDisplayName,
    validateIdentifier,
    validatePairingCode,
} from "../../../../contracts/relay/pairing.ts";
import { bearerToken } from "../../../../http/bearer-token.ts";
import { bodyParser } from "../../../../http/body-parser.ts";
import { computerFromPath, computerFromRuntimeCredential } from "../../../../http/computer-target.ts";
import { errorMiddleware, rethrowHonoError } from "../../../../http/error-middleware.ts";
import { protocolBodyLimit } from "../../../../http/protocol-body-limit.ts";
import { requestTimeoutMiddleware } from "../../../../middleware/request-timeout-middleware.ts";
import type { ComputerRouteHttpEnvironment } from "../../../http/environment.ts";
import { revokedDaemonResponse } from "../../../http/retired-daemon.ts";
import type { RelayProtocolRouteContext } from "./protocol-routes.ts";

const redeemRequestSchema = v.object({
    agents: v.unknown(),
    computerName: v.unknown(),
    pairingCode: v.unknown(),
    workspaceName: v.unknown(),
});

export function createComputerPairingRoutes(ctx: RelayProtocolRouteContext) {
    const timeout = requestTimeoutMiddleware<ComputerRouteHttpEnvironment>(30_000);
    return new Hono<ComputerRouteHttpEnvironment>()
        .onError(rethrowHonoError)
        .use("*", errorMiddleware)
        .post(
            "/computers/:computerId/pairing/redeem",
            requestTimeoutMiddleware<ComputerRouteHttpEnvironment>(15_000),
            computerFromPath,
            protocolBodyLimit,
            bodyParser<ComputerRouteHttpEnvironment, typeof redeemRequestSchema>(redeemRequestSchema),
            async (context) => {
                const body = context.req.valid("json");
                const agents = validateAgents(body.agents);
                const services = ctx.services.forComputer(context.var.computerId).services;
                const redeemed = await services.pairings.redeemComputerPairing(
                    validateIdentifier(context.req.param("computerId"), "computer_id"),
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
        )
        .get("/computers/connect", timeout, computerFromRuntimeCredential, async (context) => {
            const request = context.req.raw;
            const services = ctx.services.forComputer(context.var.computerId).services;
            const connection = await services.computerConnections.connectComputer(
                bearerToken(request),
                request.headers.get(COMPUTER_SUCCESSOR_CREDENTIAL_HEADER) ?? "",
                request.signal,
            );
            switch (connection.kind) {
                case "accepted": {
                    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
                        return new Response("WebSocket upgrade required", { status: 426 });
                    }
                    const admitted = await services.runtime.acceptDaemon(request.signal);
                    return admitted.kind === "accepted"
                        ? admitted.response
                        : Response.json(
                              { error: { code: "computer_revoked", message: "The Computer has been revoked" } },
                              { status: 401 },
                          );
                }
                case "revoked": {
                    return revokedDaemonResponse();
                }
            }
        });
}
