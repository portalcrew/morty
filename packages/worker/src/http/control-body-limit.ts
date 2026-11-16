import { bodyLimit } from "hono/body-limit";
import { RequestError } from "./request-error.ts";

export const controlBodyLimit = bodyLimit({
    maxSize: 3 * 1_024 * 1_024,
    onError: () => {
        throw new RequestError("INVALID_REQUEST", "The request body is too large.", 413);
    },
});
