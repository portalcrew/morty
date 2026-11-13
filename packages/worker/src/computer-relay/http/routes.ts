import { decodeFileReadCommand, MORTY_API_PREFIX } from "@morty-build/client/protocol";
import { Hono, type MiddlewareHandler } from "hono";
import * as v from "valibot";
import { decodeSessionRequest } from "../../contracts/agent-api/session-requests.ts";
import { ComputerManagementError } from "../../contracts/computer-management.ts";
import { COMPUTER_INTERNAL_PREFIX } from "../../contracts/computer-relay-http.ts";
import { validateIdentifier } from "../../contracts/relay/pairing.ts";
import { relayAuthenticationFromEnvironment } from "../../contracts/relay-authentication-environment.ts";
import type { WebSocketHttpDispatch } from "../../contracts/websocket-http-dispatch.ts";
import { computerFromPath } from "../../http/computer-target.ts";
import { errorMiddleware } from "../../http/error-middleware.ts";
import { json } from "../../http/json.ts";
import { RequestDeadline } from "../../http/request-deadline.ts";
import { createBrowserCors } from "../../middleware/browser-cors.ts";
import { requestTimeoutMiddleware } from "../../middleware/request-timeout-middleware.ts";
import { createRelayProtocolRoutes } from "../components/management/http/protocol-routes.ts";
import { acceptWebSocketHttpTransport } from "../components/runtime/http/websocket-http-transport.ts";
import type { ComputerRouteContext } from "../composition/computer-route-context.ts";
import type { ComputerRouteHttpEnvironment } from "./environment.ts";

/** ComputerRelay HTTP endpoints and connection upgrades. Session commands stay inside the WS dispatchers. */
export function createComputerHttpRoutes(
    ctx: ComputerRouteContext,
    dispatchHttpRequest: (request: Request) => Promise<Response>,
    dispatchWebSocket: WebSocketHttpDispatch,
) {
    const filePath = `${MORTY_API_PREFIX}/v1/computers/:computerId/harnesses/:harness/sessions/:sessionId/files/content`;
    const timeout = requestTimeoutMiddleware<ComputerRouteHttpEnvironment>(30_000);
    const cors = createBrowserCors(relayAuthenticationFromEnvironment(ctx.bindings), ["GET"], ["authorization"]);
    const authorizeTarget: MiddlewareHandler<ComputerRouteHttpEnvironment> = async (context, next) => {
        if (!ctx.ownsComputer(context.var.computerId)) {
            throw new ComputerManagementError("computer_id_mismatch", "The computer is unavailable", 421);
        }
        await next();
    };
    return new Hono<ComputerRouteHttpEnvironment>()
        .use("*", errorMiddleware)
        .post(
            `${COMPUTER_INTERNAL_PREFIX}/:computerId/account`,
            timeout,
            computerFromPath,
            authorizeTarget,
            async (context) => {
                const computerId = context.var.computerId;
                await ctx.services.accounts.create(computerId, context.req.raw.signal);
                return context.json({ computerId });
            },
        )
        .route("/", createRelayProtocolRoutes({ services: { forComputer: ctx.services.relay } }))
        .post("/__computer/bootstrap", async (context) => {
            using deadline = new RequestDeadline(context.req.raw.signal, 45_000);
            const input: unknown = await context.req.json();
            return json(await ctx.services.browser.bootstrap(input, ctx.bindings, deadline.signal), 201);
        })
        .get(
            `${MORTY_API_PREFIX}/v1/computers/:computerId/transport`,
            timeout,
            computerFromPath,
            authorizeTarget,
            (context) => {
                return acceptWebSocketHttpTransport({
                    request: context.req.raw,
                    dispatch: dispatchWebSocket,
                });
            },
        )
        .options(filePath, timeout, computerFromPath, authorizeTarget, cors)
        .get(filePath, timeout, computerFromPath, authorizeTarget, cors, async (context) => {
            const services = ctx.services.sessions(context.var.computerId);
            const target = {
                kind: "session",
                computerId: context.var.computerId,
                target: {
                    harness: validateIdentifier(context.req.param("harness"), "harness"),
                    sessionId: validateIdentifier(context.req.param("sessionId"), "session_id"),
                },
            } satisfies Parameters<typeof services.sessions.authorizeLiveEvents>[0];
            const credential = (context.req.header("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    { error: { code: "session_access_required", message: "A Session credential is required" } },
                    401,
                );
            }
            const access = await services.sessions.authorizeLiveEvents(target, credential, context.req.raw.signal);
            const path = decodeSessionRequest(
                v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
                context.req.query("path"),
            );
            const maxBytes = decodeSessionRequest(
                v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(128 * 1024 * 1024)),
                Number(context.req.query("maxBytes") ?? String(32 * 1024 * 1024)),
            );
            return services.operations.readSessionFile(
                access.computerId,
                decodeFileReadCommand(
                    JSON.stringify({
                        kind: "file.read",
                        maxBytes,
                        path,
                        requestId: crypto.randomUUID(),
                        target: target.target,
                    }),
                ),
                context.req.raw.signal,
            );
        })
        .all("/morty/api/*", (context) => dispatchHttpRequest(context.req.raw));
}
