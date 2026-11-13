import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { credentialRevocationPaths } from "../contracts/authentication/credential.ts";
import { clientLocationHeader, clientLocationOf, encodeClientLocation } from "../contracts/client-location.ts";
import type { CloudBindings } from "../contracts/cloud-bindings.ts";
import { relayAuthenticationFromEnvironment } from "../contracts/relay-authentication-environment.ts";
import { relayBindings } from "../contracts/relay-bindings.ts";
import { computerFromPath, computerFromRuntimeCredential, computerFromTransfer } from "../http/computer-target.ts";
import { errorHandler, errorMiddleware } from "../http/error-middleware.ts";
import { RequestError } from "../http/request-error.ts";
import { requestTimeoutMiddleware } from "../middleware/request-timeout-middleware.ts";
import { instructionDocumentRoutes } from "./components/instruction-documents/http/instruction-document-routes.ts";
import { cloudRoutes } from "./composition/cloud-http.ts";
import { forwardToComputer } from "./gateway/computer-object-routing.ts";
import { webPages } from "./http/web-pages.ts";

const MAXIMUM_REQUEST_BODY_BYTES = 3 * 1_024 * 1_024;

type ForwardingEnvironment = {
    readonly Bindings: CloudBindings;
    readonly Variables: { readonly signal: AbortSignal; readonly computerId?: string };
};

/** Worker dispatch only. The owning DO defines and authorizes the actual endpoints. */
function createComputerForwardingRoutes() {
    const forward: MiddlewareHandler<ForwardingEnvironment> = async (context) => {
        const computerId = context.var.computerId;
        if (computerId === undefined) {
            throw new RequestError("NOT_FOUND", "Not found.", 404);
        }
        const authentication = relayAuthenticationFromEnvironment(relayBindings(context.env));
        const origin = context.req.header("origin");
        if (
            origin !== undefined &&
            !authentication.allowedOrigins.has("*") &&
            !authentication.allowedOrigins.has(origin)
        ) {
            return context.json(
                { error: { code: "browser_origin_denied", message: "The browser origin is not allowed" } },
                403,
            );
        }
        return await forwardToComputer(context.req.raw, context.env, computerId);
    };
    const timeout = requestTimeoutMiddleware<ForwardingEnvironment>(30_000);
    const location: MiddlewareHandler<ForwardingEnvironment> = async (context, next) => {
        const headers = new Headers(context.req.raw.headers);
        const location = clientLocationOf(context.req.raw);
        headers.delete(clientLocationHeader);
        if (location !== null) {
            headers.set(clientLocationHeader, encodeClientLocation(location));
        }
        context.req.raw = new Request(context.req.raw, { headers });
        await next();
    };
    return (
        new Hono<ForwardingEnvironment>()
            .onError(errorHandler)
            .use("*", errorMiddleware, timeout)
            .get("/morty/api/v1/computers/connect", computerFromRuntimeCredential, forward)
            .post("/morty/api/v1/computers/:computerId/pairing/redeem", computerFromPath, forward)
            .put("/morty/api/v1/computers/:computerId/catalog", computerFromPath, forward)
            .get("/morty/api/v1/computers/:computerId/transport", computerFromPath, forward)
            .on(
                ["GET", "OPTIONS"],
                "/morty/api/v1/computers/:computerId/harnesses/:harness/sessions/:sessionId/files/content",
                computerFromPath,
                forward,
            )
            .post("/morty/api/v1/identity/transfers/redeem", location, computerFromTransfer, forward)
            // Setup/CLI operations retain their HTTPS endpoints.
            .post("/morty/api/v1/computers/:computerId/setup", computerFromPath, forward)
            .post("/morty/api/v1/computers/:computerId/identity/link", computerFromPath, forward)
            .post("/morty/api/v1/computers/:computerId/identity/revoke-all-access", computerFromPath, forward)
            .post("/morty/api/v1/computers/:computerId/replacement", computerFromPath, forward)
            .on(["GET", "POST"], "/morty/api/v1/computers/:computerId/pairing", computerFromPath, forward)
            .post("/morty/api/v1/computers/:computerId/setup/computers", computerFromPath, forward)
            // Shared by setup and web: HTTPS remains supported for setup after the browser moves to WebSocket.
            .post("/morty/api/v1/computers/:computerId/identity/transfers", computerFromPath, forward)
            .delete(`/morty/api/v1/computers/:computerId${credentialRevocationPaths.local}`, computerFromPath, forward)
            .get("/morty/api/v1/computers/:computerId/pairing-state", computerFromPath, forward)
            .post("/morty/api/v1/computers/:computerId/workspace", computerFromPath, forward)
            // Deprecated browser HTTP operations: remove after web clients migrate to the Computer WebSocket.
            .all("/morty/api/v1/computers/:computerId/session", computerFromPath, forward)
            .get("/morty/api/v1/computers/:computerId/identity/devices", computerFromPath, forward)
            .delete("/morty/api/v1/computers/:computerId/identity/other-browser-access", computerFromPath, forward)
            .delete("/morty/api/v1/computers/:computerId/identity/devices/:deviceId", computerFromPath, forward)
            .delete(
                `/morty/api/v1/computers/:computerId${credentialRevocationPaths.browser}`,
                computerFromPath,
                forward,
            )
            .get("/morty/api/v1/computers/:computerId", computerFromPath, forward)
            .post("/morty/api/v1/computers/:computerId/diagnostics/daemon", computerFromPath, forward)
            .post("/morty/api/v1/computers/:computerId/diagnostics/network", computerFromPath, forward)
            .post("/morty/api/v1/computers/:computerId/workspace/directory", computerFromPath, forward)
            .post("/morty/api/v1/computers/:computerId/managed-sessions", computerFromPath, forward)
            .post("/morty/api/v1/computers/:computerId/agent-settings", computerFromPath, forward)
            .post("/morty/api/v1/computers/:computerId/managed-sessions/open", computerFromPath, forward)
            .post("/morty/api/v1/computers/:computerId/native-sessions/access", computerFromPath, forward)
            .post("/morty/api/v1/computers/:computerId/managed-sessions/resolve", computerFromPath, forward)
            .post("/morty/api/v1/computers/:computerId/managed-sessions/archive", computerFromPath, forward)
            .post("/morty/api/v1/computers/:computerId/native-sessions", computerFromPath, forward)
            .post("/morty/api/v1/computers/:computerId/native-sessions/continue", computerFromPath, forward)
            .post("/morty/api/v1/computers/:computerId/native-sessions/forks/:operationId", computerFromPath, forward)
            .post("/morty/api/v1/computers/:computerId/native-sessions/:sessionId", computerFromPath, forward)
            .post("/morty/api/v1/computers/:computerId/native-sessions/:sessionId/import", computerFromPath, forward)
    );
}

const notFound = (): never => {
    throw new RequestError("NOT_FOUND", "Not found.", 404);
};

const publicApplication = new Hono<{ readonly Bindings: CloudBindings }>()
    .onError(errorHandler)
    .get("/morty/api/v1/health", bodyLimit({ maxSize: MAXIMUM_REQUEST_BODY_BYTES }), (context) =>
        context.body(null, 204),
    )
    .route("/", webPages)
    .route("/", instructionDocumentRoutes)
    .route("/morty/api", cloudRoutes)
    .route("/", createComputerForwardingRoutes())
    .notFound((context) => (context.req.path.startsWith("/doc/") ? context.text("Not found", 404) : notFound()));

export async function fetchPublicApplication(
    request: Request,
    bindings: CloudBindings,
    context?: ExecutionContext,
): Promise<Response> {
    return await publicApplication.fetch(request, bindings, context);
}

export default { fetch: fetchPublicApplication } satisfies ExportedHandler<CloudBindings, unknown>;
