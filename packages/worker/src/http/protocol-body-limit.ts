import { bodyLimit } from "hono/body-limit";
import { RequestError } from "./request-error.ts";

/** The Computer protocol's JSON request bodies are small; anything larger is refused before it is read. */
export const protocolBodyLimit = bodyLimit({
    maxSize: 256 * 1024,
    onError: () => {
        throw new RequestError("INVALID_REQUEST", "The request body is too large.", 413);
    },
});
