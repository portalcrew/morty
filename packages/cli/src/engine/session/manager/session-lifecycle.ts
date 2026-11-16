import { NativeSessionMap, NativeSessionSet } from "@portalcrew/morty-client/native-session";
import type { NativeSessionTarget } from "@portalcrew/morty-client/protocol";

/**
 * Where a Session stands in this Runtime apart from its Agent process. A Session that is neither being created nor
 * closed is open, and so is one no longer held: whether the Runtime holds a Session is the Session store's fact, so an
 * archived Session leaves no entry behind.
 */
export type SessionLifecycle =
    | { readonly kind: "open" }
    /** A creation owns initialization and failure cleanup until `settled`, which never rejects. */
    | { readonly kind: "creating"; readonly settled: Promise<void> }
    /** Archiving: clients were told `reason`, and the Agent process is being released until `settled`. */
    | { readonly kind: "closing"; readonly reason: string; readonly settled: Promise<void> };

type TransitioningLifecycle = Exclude<SessionLifecycle, { readonly kind: "open" }>;

const open: SessionLifecycle = { kind: "open" };

/**
 * Every Session's lifecycle and the native sessions an import, fork, or history read manages. Each transition is
 * synchronous, and the admission that relies on the current state is decided in the same synchronous step.
 */
export class SessionLifecycles {
    readonly #lifecycles = new NativeSessionMap<TransitioningLifecycle>();
    readonly #nativeOperations = new NativeSessionSet();

    readonly lifecycle = (target: NativeSessionTarget): SessionLifecycle => this.#lifecycles.get(target) ?? open;

    readonly managesNativeSession = (target: NativeSessionTarget): boolean => this.#nativeOperations.has(target);

    readonly beginCreation = (target: NativeSessionTarget, settled: Promise<void>): void => {
        const lifecycle = this.#lifecycles.get(target);
        if (lifecycle?.kind === "creating" || lifecycle?.kind === "closing") {
            throw new Error("A Session that is being created or closed cannot begin another creation");
        }
        this.#lifecycles.set(target, { kind: "creating", settled });
    };

    readonly endCreation = (target: NativeSessionTarget, settled: Promise<void>): void => {
        const lifecycle = this.#lifecycles.get(target);
        if (lifecycle?.kind === "creating" && lifecycle.settled === settled) {
            this.#lifecycles.delete(target);
        }
    };

    readonly beginClosing = (target: NativeSessionTarget, reason: string, settled: Promise<void>): void => {
        const lifecycle = this.#lifecycles.get(target);
        if (lifecycle?.kind === "creating" || lifecycle?.kind === "closing") {
            throw new Error("A Session that is being created or closed cannot begin closing");
        }
        this.#lifecycles.set(target, { kind: "closing", reason, settled });
    };

    readonly endClosing = (target: NativeSessionTarget, settled: Promise<void>): void => {
        const lifecycle = this.#lifecycles.get(target);
        if (lifecycle?.kind === "closing" && lifecycle.settled === settled) {
            this.#lifecycles.delete(target);
        }
    };

    readonly beginNativeOperation = (target: NativeSessionTarget): void => {
        this.#nativeOperations.add(target);
    };

    readonly endNativeOperation = (target: NativeSessionTarget): void => {
        this.#nativeOperations.delete(target);
    };

    readonly closings = (): readonly Promise<void>[] =>
        [...this.#lifecycles.values()].flatMap((lifecycle) =>
            lifecycle.kind === "closing" ? [lifecycle.settled] : [],
        );
}
