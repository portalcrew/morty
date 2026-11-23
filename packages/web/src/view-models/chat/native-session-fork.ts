import type { NativeSessionLocation } from "@portalcrew/morty-client";

export type ForkIntent = {
    readonly target: string;
    readonly operationId: string;
};

/**
 * The fork to request for `location` as of `point`, the last change the user saw in it. A fork whose answer was lost
 * keeps its identity when the user asks again at the same point, so the Computer answers with the Session it already
 * forked instead of forking a second one; once the Session has moved on, asking again forks it as it is now.
 */
export function forkIntent(
    retained: ForkIntent | null,
    location: NativeSessionLocation,
    point: string,
    newOperationId: () => string,
): ForkIntent {
    const target = JSON.stringify([location.harness, location.directory, location.sessionId, point]);
    return retained !== null && retained.target === target ? retained : { target, operationId: newOperationId() };
}
