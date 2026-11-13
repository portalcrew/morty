import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import { relayIdentifier } from "../../../../contracts/computer-management.ts";
import { ManagementError } from "../../../../contracts/management-error.ts";
import { bodyParser } from "../../../../http/body-parser.ts";
import { json } from "../../../../http/json.ts";
import { RequestDeadline } from "../../../../http/request-deadline.ts";
import { readBearerToken } from "../../../../http/request-headers.ts";
import { replaceComputer } from "../service/computer-replacement-service.ts";
import { authenticatedSession as createAuthenticatedSession, localSession } from "./authenticated-session.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";
import { applicationForRequest, type ManagementRouteContext } from "./route-context.ts";

const pairingInput = v.strictObject({ idempotencyKey: relayIdentifier });

export function createComputerManagementRoutes(ctx: ManagementRouteContext) {
    const authenticatedSession = createAuthenticatedSession(ctx);
    const noStore: MiddlewareHandler<ManagementHttpEnvironment> = async (context, next) => {
        context.header("Cache-Control", "no-store");
        await next();
    };
    const sizeLimit = bodyLimit({
        maxSize: 4096,
        onError: () => {
            throw new ManagementError("INVALID_REQUEST", "The request is too large.", 413);
        },
    });
    return new Hono<ManagementHttpEnvironment>()
        .get("/pairing-state", authenticatedSession, async (context) => {
            const application = await applicationForRequest(ctx, context);
            using deadline = new RequestDeadline(context.req.raw.signal, 45000);
            return json(
                await application.services.management.readComputer(context.get("session").computerId, deadline.signal),
            );
        })
        .get("/", sizeLimit, authenticatedSession, async (context) => {
            const application = await applicationForRequest(ctx, context);
            const session = context.get("session");
            using deadline = new RequestDeadline(context.req.raw.signal, 15000);
            return json({
                computer: await application.services.management.findComputer(session.computerId, deadline.signal),
            });
        })
        .post("/replacement", async (context) => {
            const application = await applicationForRequest(ctx, context);
            using deadline = new RequestDeadline(context.req.raw.signal, 45000);
            const signal = deadline.signal;
            const { authentication } = application.services;
            const local = await authentication.authorize(readBearerToken(context.req.raw), "replaceComputer", signal);
            switch (local.kind) {
                case "unauthenticated":
                case "revoked":
                    throw new ManagementError("UNAUTHENTICATED", "Sign in to continue.", 401);
                case "forbidden":
                    throw new ManagementError(
                        "LOCAL_IDENTITY_REQUIRED",
                        "Use the identity saved on the computer to replace it.",
                        403,
                    );
                case "authorized":
                    break;
            }
            // This optional correlation ID is untrusted diagnostics, never authorization.
            const setupRunId = v.safeParse(v.pipe(v.string(), v.uuid()), context.req.header("x-morty-setup-run-id"));
            return replaceComputer(application, local.token, setupRunId.success ? setupRunId.output : null, signal);
        })
        .post(
            "/pairing",
            noStore,
            sizeLimit,
            localSession(ctx, "pairComputer"),
            bodyParser<ManagementHttpEnvironment, typeof pairingInput>(pairingInput),
            async (context) => {
                const application = await applicationForRequest(ctx, context);
                const session = context.get("session");
                using deadline = new RequestDeadline(context.req.raw.signal, 15000);
                const input = context.req.valid("json");
                const pairing = await application.services.management.createComputerPairing(
                    session.computerId,
                    input.idempotencyKey,
                    deadline.signal,
                );
                context.header("Cache-Control", "no-store");
                return json(pairing, 201);
            },
        )
        .get("/pairing", noStore, authenticatedSession, async (context) => {
            const application = await applicationForRequest(ctx, context);
            const session = context.get("session");
            using deadline = new RequestDeadline(context.req.raw.signal, 15000);
            return json(await application.services.management.readComputerPairing(session.computerId, deadline.signal));
        });
}
