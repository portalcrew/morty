import { COMPUTER_SUCCESSOR_CREDENTIAL_HEADER } from "@morty-build/client/protocol";
import { Hono } from "hono";
import { bearerToken } from "../../../../../http/bearer-token.ts";
import { computerFromRuntimeCredential } from "../../../../../http/computer-target.ts";
import { errorMiddleware, rethrowHonoError } from "../../../../../http/error-middleware.ts";
import { requestTimeoutMiddleware } from "../../../../../middleware/request-timeout-middleware.ts";
import type { RelayProtocolEnvironment as RelayHttpEnvironment } from "../../../../route/http/environment.ts";
import type { RelayProtocolRouteContext } from "../relay-protocol-route-context.ts";

export function createDaemonConnectionRoutes(ctx: RelayProtocolRouteContext) {
    return new Hono<RelayHttpEnvironment>()
        .onError(rethrowHonoError)
        .use("*", errorMiddleware)
        .get(
            "/connect",
            requestTimeoutMiddleware<RelayHttpEnvironment>(30_000),
            computerFromRuntimeCredential,
            async (context) => {
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
                        const admitted = await services.runtime.acceptDaemon(
                            connection.access.computerId,
                            request.signal,
                        );
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
            },
        );
}
