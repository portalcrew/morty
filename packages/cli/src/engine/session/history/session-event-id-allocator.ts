import { NativeSessionMap } from "@portalcrew/morty-client/native-session";
import type { NativeSessionTarget } from "@portalcrew/morty-client/protocol";

/** Allocates each Session generation's event identifiers in order. */
export class SessionEventIdAllocator {
    readonly #allocations = new NativeSessionMap<{ readonly nextId: number; readonly sessionGenerationId: string }>();

    readonly allocate = (sessionTarget: NativeSessionTarget, sessionGenerationId: string): string => {
        const current = this.#allocations.get(sessionTarget);
        const allocatedId =
            current === undefined || current.sessionGenerationId !== sessionGenerationId ? 1 : current.nextId;
        if (!Number.isSafeInteger(allocatedId)) {
            throw new Error("The Session event ID allocation is exhausted");
        }
        this.#allocations.set(sessionTarget, { nextId: allocatedId + 1, sessionGenerationId });
        return `event-${sessionGenerationId}-${allocatedId.toString().padStart(16, "0")}`;
    };
}
