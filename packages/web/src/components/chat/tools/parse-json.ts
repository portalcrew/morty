/** The decoded JSON of a tool call's input or output, or null when it is not JSON. */
export function parseJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}
