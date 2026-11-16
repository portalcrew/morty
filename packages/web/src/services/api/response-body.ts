/**
 * The JSON body of a service response, or `undefined` when the body is not JSON, as an error page from the edge in
 * front of the Worker is not. A body that could not be read at all, such as one cancelled mid-transfer, is not
 * "no body": it fails with its own cause.
 */
export async function readJsonBody(response: Response, signal: AbortSignal): Promise<unknown> {
    try {
        return await response.json();
    } catch (cause) {
        signal.throwIfAborted();
        if (cause instanceof SyntaxError) {
            return undefined;
        }
        throw cause;
    }
}
