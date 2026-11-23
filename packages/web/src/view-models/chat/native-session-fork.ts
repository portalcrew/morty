import type { NativeSessionLocation } from "@portalcrew/morty-client";

export type ForkIntent = {
    readonly target: string;
    readonly operationId: string;
};

/**
 * The fork to request for `location`. A fork whose answer was lost keeps its identity when the user asks again, so the
 * Computer answers with the Session it already forked instead of forking a second one.
 */
export function forkIntent(
    retained: ForkIntent | null,
    location: NativeSessionLocation,
    newOperationId: () => string,
): ForkIntent {
    const target = JSON.stringify([location.harness, location.directory, location.sessionId]);
    return retained !== null && retained.target === target ? retained : { target, operationId: newOperationId() };
}
