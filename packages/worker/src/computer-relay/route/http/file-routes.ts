import { decodeFileReadCommand } from "@morty-build/client/protocol";
import { Hono, type MiddlewareHandler } from "hono";
import * as v from "valibot";
import { decodeSessionRequest } from "../../../contracts/agent-api/session-requests.ts";
import { ComputerManagementError } from "../../../contracts/computer-management.ts";
import { validateIdentifier } from "../../../contracts/relay/pairing.ts";
import { relayAuthenticationFromEnvironment } from "../../../contracts/relay-authentication-environment.ts";
import { computerFromPath } from "../../../http/computer-target.ts";
import { errorHandler, errorMiddleware } from "../../../http/error-middleware.ts";
import { createBrowserCors } from "../../../middleware/browser-cors.ts";
import { requestTimeoutMiddleware } from "../../../middleware/request-timeout-middleware.ts";
import type { ComputerRouteContext } from "../../composition/computer-route-context.ts";
import type { ComputerRouteHttpEnvironment } from "./environment.ts";

export function createComputerFileRoutes(ctx: ComputerRouteContext) {
    const filePath = "/:harness/sessions/:sessionId/files/content";
    const timeout = requestTimeoutMiddleware<ComputerRouteHttpEnvironment>(30_000);
    const cors = createBrowserCors(relayAuthenticationFromEnvironment(ctx.bindings), ["GET"], ["authorization"]);
    const authorizeTarget: MiddlewareHandler<ComputerRouteHttpEnvironment> = async (context, next) => {
        if (!ctx.ownsComputer(context.var.computerId)) {
            throw new ComputerManagementError("computer_id_mismatch", "The computer is unavailable", 421);
        }
        await next();
    };
    return new Hono<ComputerRouteHttpEnvironment>()
        .onError(errorHandler)
        .use("*", errorMiddleware)
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
        });
}
