import { bodyLimit } from "hono/body-limit";
import { RequestError } from "./request-error.ts";

export const protocolBodyLimit = bodyLimit({
    maxSize: 256 * 1024,
    onError: () => {
        throw new RequestError("INVALID_REQUEST", "The request body is too large.", 413);
    },
});
