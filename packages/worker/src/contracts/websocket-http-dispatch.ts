import type { HttpError } from "./http-error.ts";

export type WebSocketHttpOperation =
    | {
          readonly kind: "request";
          readonly request: Request;
          readonly enableCancellation: () => AbortSignal;
      }
    | {
          readonly kind: "upload-admission";
          /** The signal remains live until this upload completes, fails, times out, or disconnects. */
          readonly request: Request;
          readonly byteLength: number;
      };

/** The application owns routing and admission; the transport owns frames and connection resources. */
export type WebSocketHttpDispatch = (operation: WebSocketHttpOperation) => Promise<Response>;

/** A dispatch rejection retains the existing http.error envelope instead of becoming an HTTP response. */
export class WebSocketDispatchError extends Error implements HttpError {
    constructor() {
        super("The WebSocket transport target is invalid");
        this.name = "WebSocketDispatchError";
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: "invalid_target", message: this.message } },
        status: 400,
    });
}
