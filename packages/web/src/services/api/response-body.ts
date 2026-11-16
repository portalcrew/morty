export async function readJsonBody(response: Response, signal: AbortSignal): Promise<unknown> {
    try {
        return await response.json();
    } catch (cause) {
        signal.throwIfAborted();
        // An error page from the edge in front of the Worker is not JSON; a body that could not be read is not "no body".
        if (cause instanceof SyntaxError) {
            return undefined;
        }
        throw cause;
    }
}
