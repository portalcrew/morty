import { COMPUTER_SUCCESSOR_CREDENTIAL_HEADER } from "@morty-build/client/protocol";
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
import { pairingTimeoutMiddleware } from "../../../../middleware/pairing-timeout-middleware.ts";
import { requestTimeoutMiddleware } from "../../../../middleware/request-timeout-middleware.ts";
import type { RelayProtocolEnvironment as RelayHttpEnvironment } from "../../../http/environment.ts";
import type { RelayProtocolRouteContext } from "./protocol-routes.ts";

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
            "/computers/:computerId/pairing/redeem",
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
                    const admitted = await services.runtime.acceptDaemon(connection.access.computerId, request.signal);
                    return admitted.kind === "accepted"
                        ? admitted.response
                        : Response.json(
                              { error: { code: "computer_revoked", message: "The Computer has been revoked" } },
                              { status: 401 },
                          );
                }
                case "revoked": {
                    const pair = new WebSocketPair();
                    pair[1].accept();
                    pair[1].close(1008, "Computer revoked");
                    return new Response(null, { status: 101, webSocket: pair[0] });
                }
            }
        });
}
