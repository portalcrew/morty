import { createStore } from "zustand/vanilla";
import type { ResponseCopyModel } from "../../components/chat/response-copy-button.tsx";
import { type Clock, systemClock } from "../../services/time/clock.ts";

export function createResponseCopyStore(text: string) {
    const clipboard: Pick<Clipboard, "writeText"> | undefined = navigator.clipboard;
    const clock: Clock = systemClock;
    let lifetime: AbortController | null = null;
    let operation: AbortController | null = null;
    return createStore<ResponseCopyModel>()((set, get) => {
        const copy = async (signal: AbortSignal): Promise<void> => {
            set({ state: { kind: "copying" } });
            try {
                if (clipboard === undefined) {
                    throw new Error("Clipboard unavailable");
                }
                // The browser cannot cancel a clipboard write. Bound our wait and
                // discard any late completion after the response leaves the page.
                const deadline = new AbortController();
                try {
                    await Promise.race([
                        clipboard.writeText(text),
                        clock.sleep(10_000, AbortSignal.any([signal, deadline.signal])).then(() => {
                            throw new Error("Clipboard write timed out");
                        }),
                    ]);
                } finally {
                    deadline.abort();
                }
                signal.throwIfAborted();
                set({ state: { kind: "copied" } });
                await clock.sleep(2000, signal);
                signal.throwIfAborted();
                set({ state: { kind: "idle" } });
            } catch {
                if (!signal.aborted) {
                    set({
                        state: {
                            kind: "failed",
                            message:
                                "Could not access the clipboard. Try again or select the response and copy it manually.",
                        },
                    });
                }
            }
        };
        return {
            state: { kind: "idle" },
            onAttach: (node) => {
                if (node === null) {
                    return;
                }
                const controller = new AbortController();
                lifetime = controller;
                return () => {
                    controller.abort();
                    if (lifetime === controller) {
                        lifetime = null;
                        operation?.abort();
                        operation = null;
                    }
                };
            },
            copy: () => {
                if (lifetime !== null && get().state.kind !== "copying") {
                    operation?.abort();
                    operation = new AbortController();
                    void copy(AbortSignal.any([lifetime.signal, operation.signal]));
                }
            },
        };
    });
}
