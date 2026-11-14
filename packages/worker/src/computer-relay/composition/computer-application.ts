import { FILE_STREAM_CONTENT_TYPE } from "@morty-build/client/protocol";
import { Hono, type MiddlewareHandler } from "hono";
import type { ConfiguredRelayBindings } from "../../contracts/relay-bindings.ts";
import {
    WebSocketDispatchError,
    type WebSocketHttpDispatch,
    type WebSocketHttpOperation,
} from "../../contracts/websocket-http-dispatch.ts";
import { errorHandler } from "../../http/error-middleware.ts";
import { RequestDeadline } from "../../http/request-deadline.ts";
import { createAgentSetupRoutes } from "../components/chat/http/bot-chat-routes.ts";
import { createTransferRedemptionRoutes } from "../components/management/http/authentication-routes.ts";
import { createManagementApplication } from "../components/management/http/index.ts";
import type { ManagementHttpEnvironment } from "../components/management/http/management-http-environment.ts";
import type { ManagementRouteContext } from "../components/management/http/route-context.ts";
import { sessionContentUploadRequired } from "../components/runtime/http/session-content-upload.ts";
import { WebSocketUploadCapacity } from "../components/runtime/service/websocket-upload-capacity.ts";
import { createSessionEventSubscriptions } from "../components/runtime/websocket/session-event-subscriptions.ts";
import { createSessionWebSocketRoutes } from "../components/runtime/websocket/session-websocket-routes.ts";
import type { ComputerRouteContext } from "./computer-route-context.ts";

type WebSocketApplicationEnvironment = {
    readonly Bindings: ConfiguredRelayBindings & { readonly operation: WebSocketHttpOperation };
};

function managementRouteContext(ctx: ComputerRouteContext): ManagementRouteContext {
    return {
        services: {
            forComputer: async (computerId, signal) => {
                using deadline = new RequestDeadline(signal, 20_000);
                return await ctx.services.browser.forComputer(computerId, ctx.bindings, deadline.signal);
            },
        },
    };
}

/** HTTP and WebSocket have independent route trees; only application behavior is shared. */
export function createComputerHttpApplication(ctx: ComputerRouteContext): (request: Request) => Promise<Response> {
    const management = managementRouteContext(ctx);
    const http = new Hono<ManagementHttpEnvironment>()
        .onError(errorHandler)
        .route(
            "/morty/api/v1/computers/:computerId",
            createManagementApplication(management).route("/", createAgentSetupRoutes(management)),
        )
        .route("/morty/api/v1", createTransferRedemptionRoutes(management))
        .notFound(() =>
            Response.json(
                { error: { code: "not_found", message: "The requested Morty resource does not exist" } },
                { status: 404 },
            ),
        );

    return async (request) => await http.fetch(request, ctx.bindings);
}

/** Compose once for the owning Computer, not once for each connecting client. */
export function createComputerWebSocketApplication(ctx: ComputerRouteContext) {
    const managementContext = managementRouteContext(ctx);
    const uploads = new WebSocketUploadCapacity();
    const prepareApplicationRequest: MiddlewareHandler<WebSocketApplicationEnvironment> = async (context, next) => {
        const computerId = context.req.param("computerId");
        if (computerId === undefined || !ctx.ownsComputer(computerId)) {
            throw new WebSocketDispatchError();
        }
        const operation = context.env.operation;
        if (operation.kind === "upload-admission") {
            return sessionContentUploadRequired();
        }
        context.req.raw = new Request(context.req.raw, {
            signal: AbortSignal.any([context.req.raw.signal, operation.enableCancellation()]),
        });
        await next();
        return;
    };
    const management = new Hono<WebSocketApplicationEnvironment>()
        .use("*", prepareApplicationRequest)
        .route("/", createManagementApplication(managementContext));
    const websocket = new Hono<WebSocketApplicationEnvironment>()
        .onError((cause) => {
            throw cause;
        })
        .route(
            "/",
            createSessionWebSocketRoutes({
                ownsComputer: ctx.ownsComputer,
                services: { forComputer: ctx.services.sessions },
            }),
        )
        .route("/morty/api/v1/computers/:computerId", management)
        .notFound(() => {
            throw new WebSocketDispatchError();
        });

    const dispatch: WebSocketHttpDispatch = async (operation) => {
        const response = await websocket.fetch(operation.request, { ...ctx.bindings, operation });
        if (operation.kind === "upload-admission" && response.ok) {
            uploads.reserve({
                byteLength: operation.byteLength,
                format:
                    operation.request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
                    FILE_STREAM_CONTENT_TYPE
                        ? "encrypted-content"
                        : "ordinary",
                signal: operation.request.signal,
            });
        }
        return response;
    };
    return {
        dispatch,
        subscribe: createSessionEventSubscriptions({
            ownsComputer: ctx.ownsComputer,
            services: { forComputer: ctx.services.sessions },
            connectionOpened: ctx.utilities.connectionOpened,
        }),
    };
}
