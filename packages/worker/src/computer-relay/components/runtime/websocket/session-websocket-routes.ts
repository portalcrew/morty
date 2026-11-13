import {
    CONTENT_WRITE_MAX_BYTES,
    decodeContentWriteCommand,
    type Identifier,
    isIdentifier,
    MORTY_API_PREFIX,
    type NativeSessionTarget,
    type TurnState,
} from "@morty-build/client/protocol";
import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import * as v from "valibot";
import {
    decodeSessionRequest,
    interactionResponseRequest,
    sessionConfigurationRequest,
    sessionRenameRequest,
    turnSteerRequest,
    turnSubmissionRequest,
} from "../../../../contracts/agent-api/session-requests.ts";
import { toHttpError } from "../../../../contracts/http-error.ts";
import { PairingDirectoryError, validateIdentifier } from "../../../../contracts/relay/pairing.ts";
import { WebSocketDispatchError, type WebSocketHttpOperation } from "../../../../contracts/websocket-http-dispatch.ts";
import { RequestDeadline } from "../../../../http/request-deadline.ts";
import {
    authorizeSessionContentUpload,
    type SessionContentUploadTarget,
    sessionContentUploadRequired,
} from "../http/session-content-upload.ts";
import type { LocalSessionOperations } from "../service/local-session-operations.ts";
import type { SessionAccessService } from "../service/session-access-service.ts";
import type { TurnAdmission } from "../service/session-control.ts";
import { SessionControl } from "../service/session-control.ts";

export type SessionWebSocketServices = {
    readonly sessions: SessionAccessService;
    readonly operations: LocalSessionOperations;
};

type SessionWebSocketEnvironment = {
    readonly Bindings: { readonly operation: WebSocketHttpOperation };
    readonly Variables: {
        readonly computerId: string;
        readonly credential: string;
        readonly access: Awaited<ReturnType<SessionAccessService["authenticate"]>>;
        readonly target: NativeSessionTarget;
    };
};

const identifier = v.custom<Identifier>(isIdentifier);
const json = (value: unknown): Response => Response.json(value, { headers: { "Cache-Control": "no-store" } });
const notFound = (): Response =>
    Response.json(
        { error: { code: "not_found", message: "The requested Morty resource does not exist" } },
        { status: 404 },
    );

/** Session commands belong only to the WebSocket application's route tree. */
export function createSessionWebSocketRoutes(ctx: {
    readonly ownsComputer: (computerId: string) => boolean;
    readonly services: { readonly forComputer: (computerId: string) => SessionWebSocketServices };
}) {
    const authorizeTarget = createMiddleware<SessionWebSocketEnvironment>(async (context, next) => {
        const computerId = context.req.param("computerId");
        if (computerId === undefined || !ctx.ownsComputer(computerId)) {
            throw new WebSocketDispatchError();
        }
        // Preserve the established admission error for a missing or malformed bearer header.
        const credential = (context.req.header("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
        if (credential === undefined) {
            throw new WebSocketDispatchError();
        }
        context.set("credential", credential);
        context.set("computerId", validateIdentifier(computerId, "computer_id"));
        context.set("target", {
            harness: validateIdentifier(context.req.param("harness") ?? "", "harness"),
            sessionId: validateIdentifier(context.req.param("sessionId") ?? "", "session_id"),
        });
        await next();
        return;
    });
    const admitContentUpload = createMiddleware<SessionWebSocketEnvironment>(async (context, next) => {
        if (context.env.operation.kind === "upload-admission") {
            const services = ctx.services.forComputer(context.var.computerId);
            const authorized = await authorizeSessionContentUpload(context.req.raw, services.sessions, {
                computerId: context.var.computerId,
                target: context.var.target,
                contentKey: context.req.param("contentKey") ?? "",
            });
            return authorized instanceof Response ? authorized : new Response(null, { status: 204 });
        }
        await next();
        return;
    });
    const authenticate = createMiddleware<SessionWebSocketEnvironment>(async (context, next) => {
        if (context.env.operation.kind === "upload-admission") {
            return sessionContentUploadRequired();
        }
        using deadline = new RequestDeadline(context.req.raw.signal, 30_000);
        context.req.raw = new Request(context.req.raw, { signal: deadline.signal });
        const request = context.req.raw;
        const computerId = context.var.computerId;
        const target = context.var.target;
        const services = ctx.services.forComputer(computerId);
        const credential = context.var.credential;
        const access = await services.sessions.authenticate(
            { kind: "session", computerId, target },
            credential,
            request.signal,
        );
        context.set("access", access);
        await next();
        return;
    });
    const controlForRequest = (context: Context<SessionWebSocketEnvironment>): SessionControl => {
        const { computerId, target, access } = context.var;
        const { operations } = ctx.services.forComputer(computerId);
        const signal = context.req.raw.signal;
        return new SessionControl(async (command) => {
            await access.authorize(signal);
            return operations.requestControl(computerId, command, signal);
        }, target);
    };
    const sessionPath = `${MORTY_API_PREFIX}/v1/computers/:computerId/harnesses/:harness/sessions/:sessionId`;
    return new Hono<SessionWebSocketEnvironment>()
        .onError((cause, context) => {
            context.req.raw.signal.throwIfAborted();
            if (cause instanceof WebSocketDispatchError) {
                throw cause;
            }
            const error = toHttpError(cause);
            return Response.json(error.body, {
                status: error.status,
                ...(error.headers === undefined ? {} : { headers: error.headers }),
            });
        })
        .notFound(notFound)
        .all(`${sessionPath}/access-credentials/*`, () => {
            throw new WebSocketDispatchError();
        })
        .use(`${sessionPath}/*`, authorizeTarget)
        .put(`${sessionPath}/content/:contentKey`, admitContentUpload, authenticate, (context) =>
            uploadContent(context.req.raw, ctx.services.forComputer(context.var.computerId), {
                computerId: context.var.computerId,
                target: context.var.target,
                contentKey: context.req.param("contentKey"),
            }),
        )
        .get(`${sessionPath}/configuration`, authenticate, async (context) =>
            json(await controlForRequest(context).readConfiguration()),
        )
        .get(`${sessionPath}/active-turn`, authenticate, async (context) => {
            const commandId = context.req.query("commandId");
            return json(
                await controlForRequest(context).activeTurn(
                    commandId === undefined ? undefined : decodeSessionRequest(identifier, commandId),
                ),
            );
        })
        .post(`${sessionPath}/turns`, authenticate, async (context) => {
            const input: unknown = await context.req.json();
            const body = decodeSessionRequest(turnSubmissionRequest, input);
            const accepted = await controlForRequest(context).submitTurn({ ...body, commandId: body.idempotencyKey });
            const acceptedAt = new Date().toISOString();
            return json({
                acceptedAt,
                idempotencyKey: body.idempotencyKey,
                request: { content: body.content, kind: "prompt", sessionConfigurations: body.sessionConfigurations },
                target: context.var.target,
                state: submittedTurnState(accepted.state, acceptedAt),
                turnId: accepted.commandId,
            });
        })
        .put(`${sessionPath}/turns/:turnId/disposition`, authenticate, async (context) => {
            const turnId = decodeSessionRequest(identifier, context.req.param("turnId"));
            const input: unknown = await context.req.json();
            decodeSessionRequest(turnSteerRequest, input);
            await controlForRequest(context).steerTurn(turnId);
            return json({ turnId });
        })
        .post(`${sessionPath}/turns/:turnId/cancel-before-start`, authenticate, async (context) => {
            const turnId = decodeSessionRequest(identifier, context.req.param("turnId"));
            await controlForRequest(context).withdrawTurn(turnId);
            return json({ turnId });
        })
        .post(`${sessionPath}/turns/:turnId/cancel`, authenticate, async (context) => {
            const turnId = decodeSessionRequest(identifier, context.req.param("turnId"));
            const { stopReason } = await controlForRequest(context).cancelTurn(turnId);
            return json({ turnId, stopReason });
        })
        .post(`${sessionPath}/configuration`, authenticate, async (context) => {
            const input: unknown = await context.req.json();
            return json(
                await controlForRequest(context).configure(decodeSessionRequest(sessionConfigurationRequest, input)),
            );
        })
        .post(`${sessionPath}/rename`, authenticate, async (context) => {
            const input: unknown = await context.req.json();
            return json(
                await controlForRequest(context).rename(decodeSessionRequest(sessionRenameRequest, input).title),
            );
        })
        .post(`${sessionPath}/interactions/:interactionId/responses`, authenticate, async (context) => {
            const interactionId = decodeSessionRequest(identifier, context.req.param("interactionId"));
            const input: unknown = await context.req.json();
            await controlForRequest(context).respond(
                interactionId,
                decodeSessionRequest(interactionResponseRequest, input),
            );
            return json({ accepted: true });
        })
        .get(`${sessionPath}/events`, authenticate, async (context) => {
            const request = context.req.raw;
            const access = context.var.access;
            await access.authorize(request.signal);
            if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
                return ctx.services.forComputer(context.var.computerId).operations.openPublicSessionEvents(
                    context.var.computerId,
                    context.var.target,
                    {
                        signingKeyId: access.signingKeyId,
                        grant: access.grant,
                        expiresAt: access.expiresAtEpochMilliseconds,
                    },
                    request.signal,
                );
            }
            return json(
                await controlForRequest(context).liveEvents({
                    cursor: decodeSessionRequest(
                        v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(512))),
                        context.req.query("cursor") ?? null,
                    ),
                    eventLimit: decodeSessionRequest(
                        v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(10_000)),
                        Number(context.req.query("limit") ?? "50"),
                    ),
                }),
            );
        })
        .all(`${sessionPath}/*`, (context) =>
            context.env.operation.kind === "upload-admission" ? sessionContentUploadRequired() : notFound(),
        );
}

function submittedTurnState(state: TurnAdmission["state"], answeredAt: string): TurnState {
    switch (state) {
        case "queued":
            return { kind: "queued" };
        case "running":
            return { kind: "running", startedAt: answeredAt };
        case "settled":
            return {
                kind: "indeterminate",
                reconciliation: { detectedAt: answeredAt, reason: "dispatch_indeterminate" },
            };
    }
}

async function uploadContent(
    request: Request,
    dependencies: {
        readonly sessions: SessionAccessService;
        readonly operations: LocalSessionOperations;
    },
    location: SessionContentUploadTarget,
): Promise<Response> {
    const authorized = await authorizeSessionContentUpload(request, dependencies.sessions, location);
    if (authorized instanceof Response) {
        return authorized;
    }
    const { access, target, contentKey } = authorized;
    const byteLength = decodeSessionRequest(
        v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(CONTENT_WRITE_MAX_BYTES)),
        Number(request.headers.get("x-morty-byte-length") ?? ""),
    );
    const contentKind = decodeSessionRequest(
        v.picklist(["image", "resource"]),
        request.headers.get("x-morty-content-kind"),
    );
    const mediaType = decodeSessionRequest(
        v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
        request.headers.get("content-type"),
    );
    const encodedName = decodeSessionRequest(
        v.pipe(v.string(), v.minLength(1), v.maxLength(1_500)),
        request.headers.get("x-morty-file-name"),
    );
    const uri = decodeSessionRequest(
        v.pipe(v.string(), v.minLength(1), v.maxLength(4_096)),
        new URL(request.url).searchParams.get("uri"),
    );
    if (request.body === null) {
        throw new PairingDirectoryError("invalid_request", "The content body is required");
    }
    let name: string;
    try {
        name = decodeURIComponent(encodedName);
    } catch (cause) {
        throw new PairingDirectoryError("invalid_request", "The content name is invalid", { cause });
    }
    name = decodeSessionRequest(v.pipe(v.string(), v.minLength(1), v.maxLength(500)), name);
    const available = await dependencies.operations.writeSessionContent(
        access.computerId,
        decodeContentWriteCommand(
            JSON.stringify({
                byteLength,
                contentKey,
                contentKind,
                kind: "content.write",
                mediaType,
                name,
                requestId: crypto.randomUUID(),
                target,
            }),
        ),
        request.body,
        request.signal,
    );
    return json({ byteLength, contentKey: available.contentKey, kind: contentKind, mimeType: mediaType, name, uri });
}
