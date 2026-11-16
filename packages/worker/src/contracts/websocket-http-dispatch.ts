import type { HttpError } from "./http-error.ts";

export type WebSocketHttpOperation =
    | {
          readonly kind: "request";
          readonly request: Request;
          readonly body: string;
          readonly enableCancellation: () => AbortSignal;
      }
    | {
          readonly kind: "upload-admission";
          readonly request: Request;
          readonly byteLength: number;
      };

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
