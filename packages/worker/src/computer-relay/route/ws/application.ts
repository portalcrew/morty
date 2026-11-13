import { FILE_STREAM_CONTENT_TYPE, MORTY_API_PREFIX } from "@morty-build/client/protocol";
import { Hono, type MiddlewareHandler } from "hono";
import type { ConfiguredRelayBindings } from "../../../contracts/relay-bindings.ts";
import {
    WebSocketDispatchError,
    type WebSocketHttpDispatch,
    type WebSocketHttpOperation,
} from "../../../contracts/websocket-http-dispatch.ts";
import { errorHandler } from "../../../http/error-middleware.ts";
import { createManagementApplication } from "../../components/management/route/index.ts";
import { createSessionWebSocketRoutes } from "../../components/runtime/route/ws/session-websocket-routes.ts";
import { sessionContentUploadRequired } from "../../components/runtime/service/session-content-upload.ts";
import { WebSocketUploadCapacity } from "../../components/runtime/service/websocket-upload-capacity.ts";
import type { ComputerRouteContext } from "../../composition/computer-route-context.ts";
import { managementRouteContext } from "../management-route-context.ts";

type WebSocketApplicationEnvironment = {
    readonly Bindings: ConfiguredRelayBindings & { readonly operation: WebSocketHttpOperation };
};

/** Compose once for the owning Computer, not once for each connecting client. */
export function createComputerWebSocketApplication(ctx: ComputerRouteContext): WebSocketHttpDispatch {
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
    const computer = new Hono<WebSocketApplicationEnvironment>()
        .route(
            "/harnesses",
            createSessionWebSocketRoutes({
                ownsComputer: ctx.ownsComputer,
                services: { forComputer: ctx.services.sessions },
            }),
        )
        .route("/", management);
    const computers = new Hono<WebSocketApplicationEnvironment>().route("/:computerId", computer);
    const v1 = new Hono<WebSocketApplicationEnvironment>().route("/computers", computers);
    const websocket = new Hono<WebSocketApplicationEnvironment>()
        .onError((cause, context) => {
            if (cause instanceof WebSocketDispatchError) {
                throw cause;
            }
            return errorHandler(cause, context);
        })
        .route(MORTY_API_PREFIX, new Hono<WebSocketApplicationEnvironment>().route("/v1", v1))
        .notFound(() => {
            throw new WebSocketDispatchError();
        });

    return async (operation) => {
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
        if (response.status === 101) {
            await ctx.utilities.connectionOpened();
        }
        return response;
    };
}
