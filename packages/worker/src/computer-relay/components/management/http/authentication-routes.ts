import {
    sealedSetupHandoffFormat,
    sealedSetupHandoffPattern,
    setupHandoffLookupIdPattern,
} from "@portalcrew/morty-client/setup-handoff";
import { Hono } from "hono";
import * as v from "valibot";
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
import { controlBodyLimit } from "../../../../http/control-body-limit.ts";
import { json } from "../../../../http/json.ts";
import { RequestDeadline } from "../../../../http/request-deadline.ts";
import { readBearerToken } from "../../../../http/request-headers.ts";
import { requestTimeoutMiddleware } from "../../../../middleware/request-timeout-middleware.ts";
import { credentialRejected } from "./authenticated-session.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";
import { applicationForRequest, type ManagementRouteContext } from "./route-context.ts";

const shareInput = v.pipe(
    v.object({
        operationId: v.pipe(v.string(), v.uuid()),
        accessDuration: v.optional(v.picklist(deviceAccessDurations)),
        replaces: v.optional(v.pipe(v.string(), v.maxLength(512))),
    }),
    v.readonly(),
);
const revokeAllAccessInput = v.pipe(
    v.strictObject({
        successor: computerToken,
    }),
    v.readonly(),
);
const setupHandoffInput = v.pipe(
    v.strictObject({
        lookupId: v.pipe(v.string(), v.regex(setupHandoffLookupIdPattern)),
        sealed: v.pipe(v.string(), v.regex(sealedSetupHandoffPattern)),
        accessExpiresAt: v.pipe(v.string(), v.isoTimestamp()),
    }),
    v.readonly(),
);
const computerLinkInput = v.pipe(v.strictObject({ computerId: relayIdentifier }), v.readonly());
export function createAuthenticationRoutes(ctx: ManagementRouteContext) {
    return (
        new Hono<ManagementHttpEnvironment>()
            .post(
                "/identity/link",
                bodyParser<ManagementHttpEnvironment, typeof computerLinkInput>(computerLinkInput),
                async (context) => {
                    const application = applicationForRequest(ctx, context);
                    using deadline = new RequestDeadline(context.req.raw.signal, 15_000);
                    const result = await application.services.authentication.linkComputer(
                        context.req.valid("json").computerId,
                        readBearerToken(context.req.raw.headers),
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
                const application = applicationForRequest(ctx, context);
                const request = context.req.raw;
                if (request.method !== "GET") {
                    throw new ManagementError("METHOD_NOT_ALLOWED", "Method not allowed.", 405, {
                        Allow: "GET",
                    });
                }
                const token = readBearerToken(request.headers);
                const result = await application.services.authentication.session(token, request.signal);
                switch (result.kind) {
                    case "authenticated":
                        return json(
                            {
                                ...result.session,
                                accessExpiresAt:
                                    result.accessExpiresAt === null
                                        ? null
                                        : new Date(result.accessExpiresAt).toISOString(),
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
                    const application = applicationForRequest(ctx, context);
                    const input = context.req.valid("json");
                    const transfer = await application.services.authentication.createTransfer(
                        readBearerToken(context.req.raw.headers),
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
                            // Served by the deployment whose /continue page opens these links, so setup may issue them.
                            setupHandoffFormats: [sealedSetupHandoffFormat],
                        },
                        201,
                    );
                },
            )
            .post(
                "/identity/setup-handoffs",
                bodyParser<ManagementHttpEnvironment, typeof setupHandoffInput>(setupHandoffInput),
                async (context) => {
                    const application = applicationForRequest(ctx, context);
                    const input = context.req.valid("json");
                    const staged = await application.services.setupHandoffs.stage(
                        readBearerToken(context.req.raw.headers),
                        {
                            lookupId: input.lookupId,
                            sealed: input.sealed,
                            accessExpiresAt: Date.parse(input.accessExpiresAt),
                        },
                        context.req.raw.signal,
                    );
                    switch (staged.kind) {
                        case "staged":
                            return json({ expiresAt: new Date(staged.expiresAt).toISOString() }, 201, {
                                "Cache-Control": "no-store",
                            });
                        case "conflict":
                            throw new ManagementError(
                                "SETUP_HANDOFF_CONFLICT",
                                "Another setup link already uses this id.",
                                409,
                            );
                        case "unauthenticated":
                        case "revoked":
                            throw credentialRejected(staged.kind);
                        case "forbidden":
                            throw new ManagementError(
                                "CREDENTIAL_KIND_REQUIRED",
                                "This operation requires a different credential kind.",
                                403,
                            );
                        default: {
                            const exhaustive: never = staged;
                            return exhaustive;
                        }
                    }
                },
            )
            // The lookup id is derived from the link's key, so holding it is the only authority this read needs.
            .get("/identity/setup-handoffs/:lookupId", async (context) => {
                const application = applicationForRequest(ctx, context);
                const lookupId = context.req.param("lookupId");
                const sealed = setupHandoffLookupIdPattern.test(lookupId)
                    ? application.services.setupHandoffs.read(lookupId, context.req.raw.signal)
                    : null;
                if (sealed === null) {
                    throw new ManagementError(
                        "SETUP_HANDOFF_UNAVAILABLE",
                        "This setup link has expired. Run setup again on that computer.",
                        410,
                    );
                }
                return json({ sealed }, 200, { "Cache-Control": "no-store" });
            })
            .get("/identity/devices", async (context) => {
                const application = applicationForRequest(ctx, context);
                const result = await application.services.authentication.linkedDevices(
                    readBearerToken(context.req.raw.headers),
                    context.req.raw.signal,
                );
                if (result.kind !== "listed") {
                    throw credentialRejected(result.kind);
                }
                return json(
                    {
                        devices: result.devices.map((device) => ({
                            id: device.id,
                            joinedAt: new Date(device.joinedAt).toISOString(),
                            label: device.label,
                            location: device.location,
                            addedBy: device.addedBy,
                            accessExpiresAt: new Date(device.accessExpiresAt).toISOString(),
                        })),
                    },
                    200,
                    { "Cache-Control": "no-store" },
                );
            })
            .post(
                "/identity/revoke-all-access",
                bodyParser<ManagementHttpEnvironment, typeof revokeAllAccessInput>(revokeAllAccessInput),
                async (context) => {
                    const application = applicationForRequest(ctx, context);
                    const result = await application.services.authentication.revokeAllAccess(
                        readBearerToken(context.req.raw.headers),
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
                const application = applicationForRequest(ctx, context);
                const result = await application.services.authentication.endOtherBrowserAccess(
                    readBearerToken(context.req.raw.headers),
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
                const application = applicationForRequest(ctx, context);
                const result = await application.services.authentication.endDeviceAccess(
                    readBearerToken(context.req.raw.headers),
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
                        throw new ManagementError(
                            "DEVICE_NOT_FOUND",
                            "No such device has access to this computer.",
                            404,
                        );
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
                const application = applicationForRequest(ctx, context);
                return endAccessResponse(
                    await application.services.authentication.endBrowserAccess(
                        readBearerToken(context.req.raw.headers),
                        context.req.raw.signal,
                    ),
                );
            })
            .delete(credentialRevocationPaths.local, async (context) => {
                const application = applicationForRequest(ctx, context);
                return endAccessResponse(
                    await application.services.authentication.retireLocalCredential(
                        readBearerToken(context.req.raw.headers),
                        context.req.raw.signal,
                    ),
                );
            })
    );
}

export function createTransferRedemptionRoutes(ctx: ManagementRouteContext) {
    return new Hono<ManagementHttpEnvironment>().post(
        "/identity/transfers/redeem",
        requestTimeoutMiddleware<ManagementHttpEnvironment>(30_000),
        computerFromTransfer,
        controlBodyLimit,
        bodyParser<ManagementHttpEnvironment, typeof transferRedemptionInput>(transferRedemptionInput),
        async (context) => {
            const application = applicationForRequest(ctx, context);
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
