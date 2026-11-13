import type { SessionAccessHolder } from "@morty-build/client/protocol";
import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import * as v from "valibot";
import {
    accessInput,
    nativeContinuationInput,
    nativeDirectory,
    nativeSessionTargetInput,
} from "../../../../contracts/agent-api/chat-requests.ts";
import {
    chatAccessResponse,
    documented,
    managedSessionsResponse,
    nativeContinuationResponse,
    sessionAccessResponse,
    workspaceResponse,
} from "../../../../contracts/agent-api/responses.ts";
import type { Session } from "../../../../contracts/authentication/session.ts";
import { relayIdentifier } from "../../../../contracts/computer-management.ts";
import { bodyParser } from "../../../../http/body-parser.ts";
import { json } from "../../../../http/json.ts";
import { RequestDeadline } from "../../../../http/request-deadline.ts";
import { readBearerToken } from "../../../../http/request-headers.ts";
import {
    authenticatedSession as createAuthenticatedSession,
    credentialRejected,
    localSession,
} from "../../management/http/authenticated-session.ts";
import type { ManagementHttpEnvironment } from "../../management/http/management-http-environment.ts";
import { applicationForRequest, type ManagementRouteContext } from "../../management/http/route-context.ts";
import { type ChatScope, MINIMUM_SESSION_CREDENTIAL_SECONDS } from "../service/chat-service.ts";

const setupInput = v.strictObject({ harness: relayIdentifier });
const nativeIdentity = {
    harness: relayIdentifier,
    directory: nativeDirectory,
};
const nativeListInput = v.strictObject({
    ...nativeIdentity,
    action: v.literal("list"),
    cursor: v.nullable(relayIdentifier),
});
const nativeEntryInput = v.strictObject({ ...nativeIdentity });
const nativePreviewInput = v.strictObject({ ...nativeIdentity, sessionId: relayIdentifier });
const directoryInput = v.strictObject({ directory: nativeDirectory });
const agentSettingsInput = v.strictObject({
    harness: relayIdentifier,
    workspaceRef: nativeDirectory,
});

type AuthorizedChatEnvironment = ManagementHttpEnvironment & {
    readonly Variables: ManagementHttpEnvironment["Variables"] & {
        readonly session: Session;
        readonly accessExpiresAt: number | null;
        readonly accessHolder: SessionAccessHolder;
        readonly chatScope: ChatScope;
    };
};

async function authorizeChat(
    ctx: ManagementRouteContext,
    context: Context<AuthorizedChatEnvironment>,
    signal: AbortSignal,
) {
    const application = await applicationForRequest(ctx, context, signal);
    const computerId = v.parse(relayIdentifier, context.req.param("computerId"));
    const requester = {
        computerId: context.get("session").computerId,
        accessExpiresAt: context.get("accessExpiresAt"),
        holder: context.get("accessHolder"),
    };
    return await application.services.chat.authorize(requester, computerId, signal);
}

/**
 * Guards issuing a Session credential, which lives on at the Relay after this response. Access ending sooner than
 * the shortest Session credential is refused rather than outlived, and access that ended while the credential was
 * issued does not receive it.
 */
const createSessionCredentialGuard = (ctx: ManagementRouteContext) =>
    createMiddleware<AuthorizedChatEnvironment>(async (context, next) => {
        const accessExpiresAt = context.get("accessExpiresAt");
        if (accessExpiresAt !== null && accessExpiresAt - Date.now() < MINIMUM_SESSION_CREDENTIAL_SECONDS * 1000) {
            throw credentialRejected("revoked");
        }
        await next();
        const application = await applicationForRequest(ctx, context);
        const current = await application.services.authentication.session(
            readBearerToken(context.req.raw),
            context.req.raw.signal,
        );
        if (current.kind !== "authenticated") {
            throw credentialRejected(current.kind);
        }
    });

function createAuthorizedChat(ctx: ManagementRouteContext, timeout: number) {
    return createMiddleware<AuthorizedChatEnvironment>(async (context, next) => {
        using deadline = new RequestDeadline(context.req.raw.signal, timeout);
        context.set("chatScope", await authorizeChat(ctx, context, deadline.signal));
        await next();
    });
}

function privateJson(value: unknown) {
    const response = json(value);
    response.headers.set("Cache-Control", "no-store");
    return response;
}

export function createBotChatRoutes(ctx: ManagementRouteContext) {
    const authenticatedSession = createAuthenticatedSession(ctx);
    const issuesSessionCredential = createSessionCredentialGuard(ctx);
    const authorizedChat = (timeout = 45000) => createAuthorizedChat(ctx, timeout);
    return new Hono<AuthorizedChatEnvironment>()
        .post("/workspace", authenticatedSession, authorizedChat(), async (context) => {
            const application = await applicationForRequest(ctx, context);
            return privateJson(
                documented(
                    workspaceResponse,
                    await application.services.chat.computerConfiguration(context.get("chatScope")),
                ),
            );
        })
        .post("/diagnostics/daemon", authenticatedSession, authorizedChat(), async (context) => {
            const application = await applicationForRequest(ctx, context);
            return privateJson(await application.services.chat.daemonDiagnostics(context.get("chatScope")));
        })
        .post("/diagnostics/network", authenticatedSession, authorizedChat(), async (context) => {
            const application = await applicationForRequest(ctx, context);
            return privateJson(await application.services.chat.networkDiagnostic(context.get("chatScope")));
        })
        .post("/setup/computers", authenticatedSession, authorizedChat(), async (context) => {
            const application = await applicationForRequest(ctx, context);
            return privateJson(await application.services.chat.setupComputers(context.get("chatScope")));
        })
        .post(
            "/workspace/directory",
            authenticatedSession,
            authorizedChat(120000),
            bodyParser<AuthorizedChatEnvironment, typeof directoryInput>(directoryInput),
            async (context) => {
                const application = await applicationForRequest(ctx, context);
                return privateJson(
                    await application.services.chat.listDirectory(
                        context.get("chatScope"),
                        context.req.valid("json").directory,
                    ),
                );
            },
        )
        .post("/managed-sessions", authenticatedSession, authorizedChat(), async (context) => {
            const application = await applicationForRequest(ctx, context);
            return privateJson(
                documented(
                    managedSessionsResponse,
                    await application.services.chat.managedSessions(context.get("chatScope")),
                ),
            );
        })
        .post(
            "/agent-settings",
            authenticatedSession,
            authorizedChat(120000),
            bodyParser<AuthorizedChatEnvironment, typeof agentSettingsInput>(agentSettingsInput),
            async (context) => {
                const application = await applicationForRequest(ctx, context);
                return privateJson(
                    await application.services.chat.agentSettings(context.get("chatScope"), context.req.valid("json")),
                );
            },
        )
        .post(
            "/managed-sessions/open",
            authenticatedSession,
            issuesSessionCredential,
            authorizedChat(),
            bodyParser<AuthorizedChatEnvironment, typeof accessInput>(accessInput),
            async (context) => {
                const application = await applicationForRequest(ctx, context);
                return privateJson(
                    documented(
                        chatAccessResponse,
                        await application.services.chat.openChat(context.get("chatScope"), context.req.valid("json")),
                    ),
                );
            },
        )
        .post(
            "/native-sessions/access",
            authenticatedSession,
            issuesSessionCredential,
            authorizedChat(),
            bodyParser<AuthorizedChatEnvironment, typeof nativeSessionTargetInput>(nativeSessionTargetInput),
            async (context) => {
                const application = await applicationForRequest(ctx, context);
                const input = context.req.valid("json");
                return privateJson(
                    documented(
                        sessionAccessResponse,
                        await application.services.chat.nativeSessionAccess(context.get("chatScope"), input),
                    ),
                );
            },
        )
        .post(
            "/managed-sessions/resolve",
            authenticatedSession,
            authorizedChat(),
            bodyParser<AuthorizedChatEnvironment, typeof nativeSessionTargetInput>(nativeSessionTargetInput),
            async (context) => {
                const application = await applicationForRequest(ctx, context);
                const input = context.req.valid("json");
                return privateJson(await application.services.chat.managedSession(context.get("chatScope"), input));
            },
        )
        .post(
            "/managed-sessions/archive",
            authenticatedSession,
            authorizedChat(),
            bodyParser<AuthorizedChatEnvironment, typeof nativeSessionTargetInput>(nativeSessionTargetInput),
            async (context) => {
                const application = await applicationForRequest(ctx, context);
                const input = context.req.valid("json");
                return privateJson(
                    await application.services.chat.archiveManagedSession(context.get("chatScope"), input),
                );
            },
        )
        .post(
            "/native-sessions",
            authenticatedSession,
            authorizedChat(120000),
            bodyParser<AuthorizedChatEnvironment, typeof nativeListInput>(nativeListInput),
            async (context) => {
                const application = await applicationForRequest(ctx, context);
                return privateJson(
                    await application.services.chat.nativeSessions(context.get("chatScope"), context.req.valid("json")),
                );
            },
        )
        .post(
            "/native-sessions/continue",
            authenticatedSession,
            authorizedChat(120000),
            bodyParser<AuthorizedChatEnvironment, typeof nativeContinuationInput>(nativeContinuationInput),
            async (context) => {
                const application = await applicationForRequest(ctx, context);
                const input = context.req.valid("json");
                return privateJson(
                    documented(
                        nativeContinuationResponse,
                        await application.services.chat.continueNativeSession(
                            context.get("chatScope"),
                            input.harness,
                            input.sessionId,
                        ),
                    ),
                );
            },
        )
        .post(
            "/native-sessions/:sessionId",
            authenticatedSession,
            authorizedChat(120000),
            bodyParser<AuthorizedChatEnvironment, typeof nativeEntryInput>(nativeEntryInput),
            async (context) => {
                const application = await applicationForRequest(ctx, context);
                const sessionId = v.parse(relayIdentifier, context.req.param("sessionId"));
                return privateJson(
                    await application.services.chat.previewNativeSession(context.get("chatScope"), {
                        ...context.req.valid("json"),
                        sessionId,
                    }),
                );
            },
        )
        .post(
            "/native-sessions/:sessionId/import",
            authenticatedSession,
            authorizedChat(120000),
            bodyParser<AuthorizedChatEnvironment, typeof nativeEntryInput>(nativeEntryInput),
            async (context) => {
                const application = await applicationForRequest(ctx, context);
                const sessionId = v.parse(relayIdentifier, context.req.param("sessionId"));
                return privateJson(
                    await application.services.chat.importNativeSession(
                        context.get("chatScope"),
                        sessionId,
                        context.req.valid("json"),
                    ),
                );
            },
        )
        .post(
            "/native-sessions/forks/:operationId",
            authenticatedSession,
            authorizedChat(120000),
            bodyParser<AuthorizedChatEnvironment, typeof nativePreviewInput>(nativePreviewInput),
            async (context) => {
                const application = await applicationForRequest(ctx, context);
                const operationId = v.parse(relayIdentifier, context.req.param("operationId"));
                return privateJson(
                    await application.services.chat.recoverableNativeFork(
                        context.get("chatScope"),
                        operationId,
                        context.req.valid("json"),
                    ),
                );
            },
        )
        .post(
            "/setup",
            localSession(ctx, "verifyAgent"),
            authorizedChat(),
            bodyParser<AuthorizedChatEnvironment, typeof setupInput>(setupInput),
            async (context) => {
                const application = await applicationForRequest(ctx, context);
                const input = context.req.valid("json");
                return json(await application.services.chat.verifyAgent(context.get("chatScope"), input), 202);
            },
        );
}
