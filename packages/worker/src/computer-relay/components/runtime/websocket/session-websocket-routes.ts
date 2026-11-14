import { sameNativeSession } from "@morty-build/client/native-session";
import { MORTY_API_PREFIX, type NativeSessionTarget } from "@morty-build/client/protocol";
import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import * as v from "valibot";
import {
    activeTurnInput,
    cancelInput,
    configReadInput,
    configureInput,
    decodeSessionRequest,
    dispositionInput,
    encryptedInteractionResponseInput,
    eventsInput,
    sessionIdentifier as identifier,
    promptInput,
    renameInput,
    withdrawInput,
} from "../../../../contracts/agent-api/session-requests.ts";
import { toHttpError } from "../../../../contracts/http-error.ts";
import { PairingDirectoryError, validateIdentifier } from "../../../../contracts/relay/pairing.ts";
import { WebSocketDispatchError, type WebSocketHttpOperation } from "../../../../contracts/websocket-http-dispatch.ts";
import { bodyParser, readJsonTextBody } from "../../../../http/body-parser.ts";
import { RequestDeadline } from "../../../../http/request-deadline.ts";
import {
    authorizeSessionContentUpload,
    type SessionContentUploadTarget,
    sessionContentUploadRequired,
} from "../http/session-content-upload.ts";
import type { LocalSessionOperations } from "../service/local-session-operations.ts";
import type { SessionAccessService } from "../service/session-access-service.ts";

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

const readTransportJson = async (context: Context<SessionWebSocketEnvironment>): Promise<unknown> => {
    const operation = context.env.operation;
    if (operation.kind !== "request") {
        throw new WebSocketDispatchError();
    }
    return readJsonTextBody(operation.body, context.req.raw.headers, context.req.raw.signal);
};
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
    const authenticateWithDeadline = (timeoutMilliseconds: number) =>
        createMiddleware<SessionWebSocketEnvironment>(async (context, next) => {
            if (context.env.operation.kind === "upload-admission") {
                return sessionContentUploadRequired();
            }
            const signal = AbortSignal.any([context.req.raw.signal, context.env.operation.enableCancellation()]);
            using deadline = new RequestDeadline(signal, timeoutMilliseconds);
            context.req.raw = new Request(context.req.raw, { signal: deadline.signal });
            const request = context.req.raw;
            const computerId = context.var.computerId;
            const target = context.var.target;
            const services = ctx.services.forComputer(computerId);
            const credential = context.var.credential;
            const access = await services.sessions.authenticate({ computerId, target }, credential, request.signal);
            context.set("access", access);
            await next();
            return;
        });
    const authenticate = authenticateWithDeadline(30_000);
    const authenticateUpload = authenticateWithDeadline(120_000);
    const sendSessionControl = async (
        context: Context<SessionWebSocketEnvironment>,
        command:
            | v.InferOutput<typeof promptInput>
            | v.InferOutput<typeof cancelInput>
            | v.InferOutput<typeof withdrawInput>
            | v.InferOutput<typeof dispositionInput>
            | v.InferOutput<typeof configureInput>
            | v.InferOutput<typeof renameInput>
            | v.InferOutput<typeof encryptedInteractionResponseInput>,
    ): Promise<Response> => {
        if (!sameNativeSession(command.target, context.var.target)) {
            throw new PairingDirectoryError("invalid_request", "The command does not match its Session");
        }
        const signal = context.req.raw.signal;
        await context.var.access.authorize(signal);
        return json(
            await ctx.services
                .forComputer(context.var.computerId)
                .operations.requestClientControl(context.var.computerId, command, signal),
        );
    };
    const sessionPath = `${MORTY_API_PREFIX}/v1/computers/:computerId/harnesses/:harness/sessions/:sessionId`;
    return new Hono<SessionWebSocketEnvironment>()
        .onError((cause, context) => {
            context.req.raw.signal.throwIfAborted();
            if (cause instanceof WebSocketDispatchError) {
                throw cause;
            }
            const error = toHttpError(
                cause instanceof v.ValiError
                    ? new PairingDirectoryError("invalid_request", "The Session request is invalid", { cause })
                    : cause,
            );
            return Response.json(error.body, {
                status: error.status,
                ...(error.headers === undefined ? {} : { headers: error.headers }),
            });
        })
        .notFound(notFound)
        .use(`${sessionPath}/*`, authorizeTarget)
        .put(`${sessionPath}/content/:contentKey`, admitContentUpload, authenticateUpload, (context) =>
            uploadContent(context.req.raw, ctx.services.forComputer(context.var.computerId), {
                computerId: context.var.computerId,
                target: context.var.target,
                contentKey: context.req.param("contentKey"),
            }),
        )
        .get(
            `${sessionPath}/configuration`,
            authenticate,
            bodyParser<SessionWebSocketEnvironment, typeof configReadInput>(configReadInput, readTransportJson),
            async (context) => {
                const command = context.req.valid("json");
                if (!sameNativeSession(command.target, context.var.target)) {
                    throw new PairingDirectoryError("invalid_request", "The command does not match its Session");
                }
                const signal = context.req.raw.signal;
                await context.var.access.authorize(signal);
                return json(
                    await ctx.services
                        .forComputer(context.var.computerId)
                        .operations.requestClientControl(context.var.computerId, command, signal),
                );
            },
        )
        .get(
            `${sessionPath}/active-turn`,
            authenticate,
            bodyParser<SessionWebSocketEnvironment, typeof activeTurnInput>(activeTurnInput, readTransportJson),
            async (context) => {
                const commandId = context.req.query("commandId");
                if (commandId !== undefined) {
                    decodeSessionRequest(identifier, commandId);
                }
                const command = context.req.valid("json");
                if (!("target" in command) || !sameNativeSession(command.target, context.var.target)) {
                    throw new PairingDirectoryError("invalid_request", "The command does not match its Session");
                }
                const signal = context.req.raw.signal;
                await context.var.access.authorize(signal);
                return json(
                    await ctx.services
                        .forComputer(context.var.computerId)
                        .operations.requestClientControl(context.var.computerId, command, signal),
                );
            },
        )
        .post(
            `${sessionPath}/turns`,
            authenticate,
            bodyParser<SessionWebSocketEnvironment, typeof promptInput>(promptInput),
            async (context) => {
                const command = context.req.valid("json");
                return sendSessionControl(context, command);
            },
        )
        .put(
            `${sessionPath}/turns/:turnId/disposition`,
            authenticate,
            bodyParser<SessionWebSocketEnvironment, typeof dispositionInput>(dispositionInput),
            async (context) => {
                const command = context.req.valid("json");
                if (command.commandId !== decodeSessionRequest(identifier, context.req.param("turnId"))) {
                    throw new PairingDirectoryError("invalid_request", "The command does not match its Turn");
                }
                return sendSessionControl(context, command);
            },
        )
        .post(
            `${sessionPath}/turns/:turnId/cancel-before-start`,
            authenticate,
            bodyParser<SessionWebSocketEnvironment, typeof withdrawInput>(withdrawInput),
            async (context) => {
                const command = context.req.valid("json");
                if (command.commandId !== decodeSessionRequest(identifier, context.req.param("turnId"))) {
                    throw new PairingDirectoryError("invalid_request", "The command does not match its Turn");
                }
                return sendSessionControl(context, command);
            },
        )
        .post(
            `${sessionPath}/turns/:turnId/cancel`,
            authenticate,
            bodyParser<SessionWebSocketEnvironment, typeof cancelInput>(cancelInput),
            async (context) => {
                const command = context.req.valid("json");
                if (command.commandId !== decodeSessionRequest(identifier, context.req.param("turnId"))) {
                    throw new PairingDirectoryError("invalid_request", "The command does not match its Turn");
                }
                return sendSessionControl(context, command);
            },
        )
        .post(
            `${sessionPath}/configuration`,
            authenticate,
            bodyParser<SessionWebSocketEnvironment, typeof configureInput>(configureInput),
            async (context) => {
                return sendSessionControl(context, context.req.valid("json"));
            },
        )
        .post(
            `${sessionPath}/rename`,
            authenticate,
            bodyParser<SessionWebSocketEnvironment, typeof renameInput>(renameInput),
            async (context) => {
                return sendSessionControl(context, context.req.valid("json"));
            },
        )
        .post(
            `${sessionPath}/interactions/:interactionId/responses`,
            authenticate,
            bodyParser<SessionWebSocketEnvironment, typeof encryptedInteractionResponseInput>(
                encryptedInteractionResponseInput,
            ),
            async (context) => {
                const command = context.req.valid("json");
                if (command.interactionId !== decodeSessionRequest(identifier, context.req.param("interactionId"))) {
                    throw new PairingDirectoryError("invalid_request", "The command does not match its interaction");
                }
                return sendSessionControl(context, command);
            },
        )
        .get(
            `${sessionPath}/events`,
            authenticate,
            bodyParser<SessionWebSocketEnvironment, typeof eventsInput>(eventsInput, readTransportJson),
            async (context) => {
                const request = context.req.raw;
                await context.var.access.authorize(request.signal);
                const command = context.req.valid("json");
                if (
                    command.kind !== "session.live-history.v2.page.load" ||
                    !sameNativeSession(command.target, context.var.target)
                ) {
                    throw new PairingDirectoryError("invalid_request", "The command does not match its Session");
                }
                return json(
                    await ctx.services
                        .forComputer(context.var.computerId)
                        .operations.requestClientControl(context.var.computerId, command, request.signal),
                );
            },
        )
        .all(`${sessionPath}/*`, (context) =>
            context.env.operation.kind === "upload-admission" ? sessionContentUploadRequired() : notFound(),
        );
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
    const { access, target } = authorized;
    if (request.body === null) {
        throw new PairingDirectoryError("invalid_request", "The content body is required");
    }
    const available = await dependencies.operations.writeSessionContent(
        access.computerId,
        target,
        request.body,
        request.signal,
    );
    return new Response(available, {
        headers: { "cache-control": "no-store", "content-type": "application/json" },
    });
}
