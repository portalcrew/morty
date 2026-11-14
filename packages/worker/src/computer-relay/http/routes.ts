import {
    type FileReadCommandRouting,
    fileReadCommandCodec,
    MORTY_API_PREFIX,
    type NativeSessionTarget,
} from "@morty-build/client/protocol";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ComputerManagementError } from "../../contracts/computer-management.ts";
import { COMPUTER_INTERNAL_PREFIX } from "../../contracts/computer-relay-http.ts";
import { computerNotFound } from "../../contracts/management-error.ts";
import { PairingDirectoryError, validateIdentifier } from "../../contracts/relay/pairing.ts";
import { relayAuthenticationFromEnvironment } from "../../contracts/relay-authentication-environment.ts";
import type { SubscribeSessionEvents } from "../../contracts/session-event-subscription.ts";
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
    websocket: { readonly dispatch: WebSocketHttpDispatch; readonly subscribe: SubscribeSessionEvents },
) {
    const filePath = `${MORTY_API_PREFIX}/v1/computers/:computerId/harnesses/:harness/sessions/:sessionId/files/content`;
    const timeout = requestTimeoutMiddleware<ComputerRouteHttpEnvironment>(30_000);
    const cors = createBrowserCors(
        relayAuthenticationFromEnvironment(ctx.bindings),
        ["POST"],
        ["authorization", "content-type"],
    );
    // An encrypted file read holds one path of at most 4,096 characters beside its routing.
    const fileReadLimit = bodyLimit({
        maxSize: 16 * 1024,
        onError: () => {
            throw new PairingDirectoryError("invalid_request", "The Session request is invalid");
        },
    });
    const authorizeTarget: MiddlewareHandler<ComputerRouteHttpEnvironment> = async (context, next) => {
        if (!ctx.ownsComputer(context.var.computerId)) {
            throw new ComputerManagementError("computer_id_mismatch", "The computer is unavailable", 421);
        }
        await next();
    };
    return (
        new Hono<ComputerRouteHttpEnvironment>()
            .use("*", errorMiddleware)
            .post(
                `${COMPUTER_INTERNAL_PREFIX}/:computerId/account`,
                timeout,
                computerFromPath,
                authorizeTarget,
                async (context) => {
                    const computerId = context.var.computerId;
                    await ctx.services.accounts.create(context.req.raw.signal);
                    return context.json({ computerId });
                },
            )
            // A request for a computer that was never created is refused here, before any route accepts a connection or
            // opens storage for it. A CORS preflight asks for nothing, so it is answered either way.
            .use("*", async (context, next) => {
                if (context.req.method !== "OPTIONS" && !ctx.holdsComputer()) {
                    throw computerNotFound();
                }
                await next();
            })
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
                        dispatch: websocket.dispatch,
                        subscribe: websocket.subscribe,
                    });
                },
            )
            .options(filePath, timeout, computerFromPath, authorizeTarget, cors)
            .post(filePath, timeout, computerFromPath, authorizeTarget, cors, fileReadLimit, async (context) => {
                const services = ctx.services.sessions(context.var.computerId);
                const target = {
                    computerId: context.var.computerId,
                    target: {
                        harness: validateIdentifier(context.req.param("harness"), "harness"),
                        sessionId: validateIdentifier(context.req.param("sessionId"), "session_id"),
                    },
                } satisfies Parameters<typeof services.sessions.authorizeSession>[0];
                const credential = (context.req.header("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
                if (credential === undefined) {
                    return context.json(
                        { error: { code: "session_access_required", message: "A Session credential is required" } },
                        401,
                    );
                }
                await services.sessions.authorizeSession(target, credential, context.req.raw.signal);
                const command = decodeFileRead(await context.req.text(), target.target);
                return services.operations.readSessionFile(command, context.req.raw.signal);
            })
            .all("/morty/api/*", (context) => dispatchHttpRequest(context.req.raw))
    );
}

/** The read is encrypted for the Computer; the Relay checks only that it addresses the Session the URL authorized. */
function decodeFileRead(encoded: string, authorized: NativeSessionTarget): FileReadCommandRouting {
    let command: FileReadCommandRouting;
    try {
        command = fileReadCommandCodec.decodeRouting(encoded);
    } catch (cause) {
        throw new PairingDirectoryError("invalid_request", "The Session request is invalid", { cause });
    }
    if (command.target.harness !== authorized.harness || command.target.sessionId !== authorized.sessionId) {
        throw new PairingDirectoryError("invalid_request", "The Session request is invalid");
    }
    return command;
}
