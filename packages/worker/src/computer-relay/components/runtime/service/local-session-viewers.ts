import type {
    SessionEventObserver,
    SessionViewer,
    SessionViewerIdentity,
} from "../../../../contracts/session-event-subscription.ts";

/** Direct subscriptions participate in the same expiry and revocation checks as retained viewers. */
export class LocalSessionViewers {
    readonly #viewers = new Set<SessionViewer>();
    readonly viewers = () => [...this.#viewers];

    /** Registers the viewer for the subscription's lifetime; the returned function drops it without notifying. */
    readonly open = (
        identity: SessionViewerIdentity,
        observer: SessionEventObserver,
        signal: AbortSignal,
    ): (() => void) => {
        signal.throwIfAborted();
        const release = (): boolean => {
            if (!this.#viewers.delete(viewer)) {
                return false;
            }
            signal.removeEventListener("abort", abort);
            return true;
        };
        const close = (code: number, reason: string): void => {
            if (release()) {
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
            release();
        };
    };
}
