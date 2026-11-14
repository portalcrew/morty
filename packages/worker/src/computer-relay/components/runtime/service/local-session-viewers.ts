import type {
    SessionEventObserver,
    SessionViewer,
    SessionViewerIdentity,
} from "../../../../contracts/session-event-subscription.ts";

/** Direct subscriptions participate in the same expiry and revocation checks as retained viewers. */
export class LocalSessionViewers {
    readonly #viewers = new Set<SessionViewer>();
    /** Runs once for every viewer the Computer subscribed that leaves, whatever ended it. */
    readonly #removed: (identity: SessionViewerIdentity) => void;
    readonly viewers = () => [...this.#viewers];

    constructor(removed: (identity: SessionViewerIdentity) => void) {
        this.#removed = removed;
    }

    /**
     * Registers the viewer for the subscription's lifetime. The returned function drops a viewer whose subscription the
     * Computer never received, so there is nothing to cancel there and its observer is not told.
     */
    readonly open = (
        identity: SessionViewerIdentity,
        observer: SessionEventObserver,
        signal: AbortSignal,
    ): (() => void) => {
        signal.throwIfAborted();
        const remove = (): boolean => {
            if (!this.#viewers.delete(viewer)) {
                return false;
            }
            signal.removeEventListener("abort", abort);
            return true;
        };
        const close = (code: number, reason: string): void => {
            if (remove()) {
                this.#removed(identity);
                observer.close(code, reason);
            }
        };
        const abort = (): void => close(1000, "Session event subscription closed");
        const viewer: SessionViewer = {
            identity,
            close,
            message: (message) => {
                if (this.#viewers.has(viewer)) {
                    observer.message(message);
                }
            },
        };
        this.#viewers.add(viewer);
        signal.addEventListener("abort", abort, { once: true });
        return () => {
            remove();
        };
    };
}
