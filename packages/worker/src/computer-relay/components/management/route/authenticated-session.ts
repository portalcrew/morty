import type { SessionAccessHolder } from "@morty-build/client/protocol";
import { createMiddleware } from "hono/factory";
import { accessHolder, type LocalOperation } from "../../../../contracts/authentication/credential.ts";
import type { Session } from "../../../../contracts/authentication/session.ts";
import { ManagementError } from "../../../../contracts/management-error.ts";
import { readBearerToken } from "../../../../http/request-headers.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";
import { applicationForRequest, type ManagementRouteContext } from "./route-context.ts";

type SessionEnvironment = ManagementHttpEnvironment & {
    Variables: {
        readonly session: Session;
        readonly accessExpiresAt: number | null;
        readonly accessHolder: SessionAccessHolder;
    };
};

export const authenticatedSession = (ctx: ManagementRouteContext) =>
    createMiddleware<SessionEnvironment>(async (context, next) => {
        const application = await applicationForRequest(ctx, context);
        const result = await application.services.authentication.session(
            readBearerToken(context.req.raw),
            context.req.raw.signal,
        );
        switch (result.kind) {
            case "authenticated":
                context.set("session", result.session);
                context.set("accessExpiresAt", result.accessExpiresAt);
                context.set("accessHolder", result.holder);
                await next();
                return;
            case "unauthenticated":
            case "revoked":
                throw credentialRejected(result.kind);
        }
    });

/** Admits only the computer's local credential, for an operation no shared access may perform. */
export const localSession = (ctx: ManagementRouteContext, operation: LocalOperation) =>
    createMiddleware<SessionEnvironment>(async (context, next) => {
        const application = await applicationForRequest(ctx, context);
        const result = await application.services.authentication.authorize(
            readBearerToken(context.req.raw),
            operation,
            context.req.raw.signal,
        );
        switch (result.kind) {
            case "authorized":
                context.set("session", {
                    computerId: application.identity.computerId,
                });
                context.set("accessExpiresAt", null);
                context.set("accessHolder", accessHolder(result.credential));
                await next();
                return;
            case "unauthenticated":
            case "revoked":
                throw credentialRejected(result.kind);
            case "forbidden":
                throw localIdentityRequired();
        }
    });

function localIdentityRequired(): ManagementError {
    return new ManagementError(
        "LOCAL_IDENTITY_REQUIRED",
        "Use the identity saved on the computer for this operation.",
        403,
    );
}

/**
 * The answer for a credential that does not authenticate. Revoked access keeps the UNAUTHENTICATED code that released
 * pages read and names its reason, so a page can tell that its access ended from a credential it never held.
 */
export function credentialRejected(kind: "unauthenticated" | "revoked"): ManagementError {
    switch (kind) {
        case "unauthenticated":
            return new ManagementError("UNAUTHENTICATED", "Sign in to continue.", 401);
        case "revoked":
            return new ManagementError(
                "UNAUTHENTICATED",
                "Access to this computer has ended.",
                401,
                {},
                {
                    reason: "ACCESS_REVOKED",
                },
            );
    }
}
