import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import { metadataInput } from "../../../../contracts/agent-api/chat-requests.ts";
import { transferRedemptionInput } from "../../../../contracts/agent-api/identity-requests.ts";
import { documented, identityResponse } from "../../../../contracts/agent-api/responses.ts";
import {
    computerToken,
    credentialRevocationPaths,
    defaultDeviceAccessDuration,
    deviceAccessDurations,
} from "../../../../contracts/authentication/credential.ts";
import { clientLocationHeader, decodeClientLocation } from "../../../../contracts/client-location.ts";
import { relayIdentifier } from "../../../../contracts/computer-management.ts";
import { ManagementError } from "../../../../contracts/management-error.ts";
import { bodyParser } from "../../../../http/body-parser.ts";
import { computerFromTransfer } from "../../../../http/computer-target.ts";
import { json } from "../../../../http/json.ts";
import { RequestDeadline } from "../../../../http/request-deadline.ts";
import { readBearerToken } from "../../../../http/request-headers.ts";
import { requestTimeoutMiddleware } from "../../../../middleware/request-timeout-middleware.ts";
import { credentialRejected } from "./authenticated-session.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";
import { applicationForRequest, type ManagementRouteContext } from "./route-context.ts";

const shareInput = v.pipe(
    v.object({
        /** Stable across retries of this exact issuance intent. */
        operationId: v.pipe(v.string(), v.uuid()),
        /** How long the device the link adds keeps access; a day unless chosen. */
        accessDuration: v.optional(v.picklist(deviceAccessDurations)),
        /** A link this access shared that no one opened yet; it stops working once the new one is issued. */
        replaces: v.optional(v.pipe(v.string(), v.maxLength(512))),
    }),
    v.readonly(),
);
const revokeAllAccessInput = v.pipe(
    v.strictObject({
        /** The local credential that replaces the caller's; setup saved it before sending this request. */
        successor: computerToken,
    }),
    v.readonly(),
);
const computerLinkInput = v.pipe(v.strictObject({ computerId: relayIdentifier }), v.readonly());
export function createAuthenticationRoutes(ctx: ManagementRouteContext) {
    return new Hono<ManagementHttpEnvironment>()
        .post(
            "/identity/link",
            bodyParser<ManagementHttpEnvironment, typeof computerLinkInput>(computerLinkInput),
            async (context) => {
                const application = await applicationForRequest(ctx, context);
                using deadline = new RequestDeadline(context.req.raw.signal, 15_000);
                const result = await application.services.authentication.linkComputer(
                    context.req.valid("json").computerId,
                    readBearerToken(context.req.raw),
                    deadline.signal,
                );
                switch (result.kind) {
                    case "linked":
                        return json({ computerId: result.computerId }, 200, {
                            "Cache-Control": "no-store",
                        });
                    case "unauthenticated":
                    case "revoked":
                        throw credentialRejected(result.kind);
                    case "mismatch":
                        throw new ManagementError(
                            "IDENTITY_CONFLICT",
                            "The identity does not match this computer.",
                            403,
                        );
                    default: {
                        const exhaustive: never = result;
                        return exhaustive;
                    }
                }
            },
        )
        .all("/session", async (context) => {
            const application = await applicationForRequest(ctx, context);
            const request = context.req.raw;
            if (request.method !== "GET") {
                throw new ManagementError("METHOD_NOT_ALLOWED", "Method not allowed.", 405, {
                    Allow: "GET",
                });
            }
            const token = readBearerToken(request);
            const result = await application.services.authentication.session(token, request.signal);
            switch (result.kind) {
                case "authenticated":
                    // A browser's access ends at its device's term, the latest among the links the device opened; other
                    // credentials have none.
                    return json(
                        {
                            ...result.session,
                            accessExpiresAt:
                                result.accessExpiresAt === null ? null : new Date(result.accessExpiresAt).toISOString(),
                        },
                        200,
                        {
                            "Cache-Control": "no-store",
                            "Morty-Credential-Revocation": credentialRevocationPaths[result.credentialKind],
                        },
                    );
                case "unauthenticated":
                case "revoked":
                    throw credentialRejected(result.kind);
            }
        })
        .post(
            "/identity/transfers",
            bodyParser<ManagementHttpEnvironment, typeof shareInput>(shareInput),
            async (context) => {
                const application = await applicationForRequest(ctx, context);
                const input = context.req.valid("json");
                const transfer = await application.services.authentication.createTransfer(
                    readBearerToken(context.req.raw),
                    {
                        operationId: input.operationId,
                        duration: input.accessDuration ?? defaultDeviceAccessDuration,
                        replaces: input.replaces ?? null,
                    },
                    context.req.raw.signal,
                );
                if (transfer === null) {
                    throw new ManagementError("UNAUTHENTICATED", "Anonymous identity is required.", 401);
                }
                const url = new URL(
                    "/continue",
                    v.parse(v.pipe(v.string(), v.url()), application.config.bindings.APP_ORIGIN),
                );
                url.hash = `code=${transfer.code}`;
                return json(
                    {
                        expiresAt: new Date(transfer.expiresAt).toISOString(),
                        accessExpiresAt: new Date(transfer.accessExpiresAt).toISOString(),
                        accessDuration: transfer.accessDuration,
                        accessLimitedBySharer: transfer.accessLimitedBySharer,
                        url: url.toString(),
                    },
                    201,
                );
            },
        )
        .post(
            "/identity/devices",
            bodyParser<ManagementHttpEnvironment, typeof metadataInput>(metadataInput),
            async (context) => {
                const application = await applicationForRequest(ctx, context);
                const access = await application.services.authentication.session(
                    readBearerToken(context.req.raw),
                    context.req.raw.signal,
                );
                if (access.kind !== "authenticated") {
                    throw credentialRejected(access.kind);
                }
                const result = await application.services.computers.readMetadata(
                    context.var.computerId,
                    context.req.valid("json"),
                    context.req.raw.signal,
                );
                return json(result, 200, { "Cache-Control": "no-store" });
            },
        )
        .post(
            "/identity/revoke-all-access",
            bodyParser<ManagementHttpEnvironment, typeof revokeAllAccessInput>(revokeAllAccessInput),
            async (context) => {
                const application = await applicationForRequest(ctx, context);
                const result = await application.services.authentication.revokeAllAccess(
                    readBearerToken(context.req.raw),
                    context.req.valid("json").successor,
                    context.req.raw.signal,
                );
                switch (result.kind) {
                    case "revoked":
                        return json({ status: "access_revoked" }, 200, { "Cache-Control": "no-store" });
                    case "unauthenticated":
                        throw new ManagementError("UNAUTHENTICATED", "Local identity is required.", 401);
                    case "forbidden":
                        throw new ManagementError(
                            "LOCAL_IDENTITY_REQUIRED",
                            "Use the original identity saved on the computer to revoke all access.",
                            403,
                        );
                }
            },
        )
        .delete("/identity/other-browser-access", async (context) => {
            const application = await applicationForRequest(ctx, context);
            const result = await application.services.authentication.endOtherBrowserAccess(
                readBearerToken(context.req.raw),
                context.req.raw.signal,
            );
            switch (result.kind) {
                case "ended":
                    return json({ status: "other_browser_access_ended" }, 200, { "Cache-Control": "no-store" });
                case "unauthenticated":
                    throw new ManagementError("UNAUTHENTICATED", "Sign in to continue.", 401);
                case "forbidden":
                    throw new ManagementError(
                        "CREDENTIAL_KIND_REQUIRED",
                        "This operation requires a different credential kind.",
                        403,
                    );
            }
        })
        .delete("/identity/devices/:deviceId", async (context) => {
            const application = await applicationForRequest(ctx, context);
            const result = await application.services.authentication.endDeviceAccess(
                readBearerToken(context.req.raw),
                context.req.param("deviceId"),
                context.req.raw.signal,
            );
            switch (result.kind) {
                case "ended":
                    return json({ status: "device_access_ended" }, 200, { "Cache-Control": "no-store" });
                case "own":
                    throw new ManagementError(
                        "OWN_DEVICE",
                        "End this browser's access with End current access instead.",
                        409,
                    );
                case "unknown":
                    throw new ManagementError("DEVICE_NOT_FOUND", "No such device has access to this computer.", 404);
                case "unauthenticated":
                    throw new ManagementError("UNAUTHENTICATED", "Sign in to continue.", 401);
                case "forbidden":
                    throw new ManagementError(
                        "CREDENTIAL_KIND_REQUIRED",
                        "This operation requires a different credential kind.",
                        403,
                    );
            }
        })
        .delete(credentialRevocationPaths.browser, async (context) => {
            const application = await applicationForRequest(ctx, context);
            return endAccessResponse(
                await application.services.authentication.endBrowserAccess(
                    readBearerToken(context.req.raw),
                    context.req.raw.signal,
                ),
            );
        })
        .delete(credentialRevocationPaths.local, async (context) => {
            const application = await applicationForRequest(ctx, context);
            return endAccessResponse(
                await application.services.authentication.retireLocalCredential(
                    readBearerToken(context.req.raw),
                    context.req.raw.signal,
                ),
            );
        });
}

export function createTransferRedemptionRoutes(ctx: ManagementRouteContext) {
    return new Hono<ManagementHttpEnvironment>().post(
        "/identity/transfers/redeem",
        requestTimeoutMiddleware<ManagementHttpEnvironment>(30_000),
        computerFromTransfer,
        bodyLimit({ maxSize: 3 * 1_024 * 1_024 }),
        bodyParser<ManagementHttpEnvironment, typeof transferRedemptionInput>(transferRedemptionInput),
        async (context) => {
            const application = await applicationForRequest(ctx, context);
            const input = context.req.valid("json");
            const identity = await application.services.management.redeemTransfer(
                input.code,
                input.replaces ?? null,
                {
                    label: input.device ?? null,
                    location: decodeClientLocation(context.req.raw.headers.get(clientLocationHeader)),
                },
                input.redemptionKey ?? null,
                context.req.raw.signal,
            );
            if (identity === null) {
                throw new ManagementError(
                    "TRANSFER_UNAVAILABLE",
                    "This link was already used, has expired, or was revoked.",
                    410,
                );
            }
            return json(documented(identityResponse, identity));
        },
    );
}

// Deletion answers 204; a credential that no longer authenticates answers 401, so a retry after a lost reply is safe.
// A timeout is ambiguous: retry the same operation.
function endAccessResponse(result: { readonly kind: "ended" | "unauthenticated" | "forbidden" }): Response {
    switch (result.kind) {
        case "ended":
            return new Response(null, { status: 204 });
        case "unauthenticated":
            throw new ManagementError("UNAUTHENTICATED", "Sign in to continue.", 401);
        case "forbidden":
            throw new ManagementError(
                "CREDENTIAL_KIND_REQUIRED",
                "This operation requires a different credential kind.",
                403,
            );
    }
}
