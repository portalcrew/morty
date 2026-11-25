import { createStore } from "zustand/vanilla";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import { isNewerMortyRelease } from "../../services/release/morty-release.ts";
import type { Clock } from "../../services/time/clock.ts";
import type { ComputerStatusStoreApi } from "./computer-status-store.ts";

type ComputerReleaseState =
    | { readonly kind: "unknown" }
    | { readonly kind: "current"; readonly running: string }
    // A newer release exists; it is mentioned only where the person looks up the version.
    | { readonly kind: "available"; readonly running: string; readonly latest: string }
    // The Computer lacks a release that is a week old, so the page draws attention to the update.
    | { readonly kind: "overdue"; readonly running: string; readonly latest: string }
    // This page saw the Computer move from an older release to the latest one.
    | { readonly kind: "updated"; readonly running: string };

export interface ComputerReleaseStore {
    readonly state: ComputerReleaseState;
    /**
     * Asks an online Computer which release it runs: with each configuration, and when the page is back from being
     * offline or in the background, since the Computer may have restarted meanwhile without changing its configuration.
     */
    readonly check: () => void;
    readonly dispose: () => void;
}

const RELEASE_READ_TIMEOUT_MILLISECONDS = 15_000;
// A read can fail while the Computer is still settling in; spaced retries recover it without a reload.
const RELEASE_READ_DELAYS_MILLISECONDS = [0, 5_000, 15_000, 45_000];

function nextReleaseState(
    previous: ComputerReleaseState,
    running: string,
    latest: string,
    weekAgo: string | null,
): ComputerReleaseState {
    if (isNewerMortyRelease(latest, running)) {
        return weekAgo !== null && isNewerMortyRelease(weekAgo, running)
            ? { kind: "overdue", running, latest }
            : { kind: "available", running, latest };
    }
    return previous.kind === "available" || previous.kind === "overdue"
        ? { kind: "updated", running }
        : { kind: "current", running };
}

export const createComputerReleaseStore = (options: {
    readonly latest: string | null;
    readonly weekAgo: string | null;
    readonly requests: Pick<BotChatApi, "daemonDiagnostics">;
    readonly computer: ComputerStatusStoreApi;
    readonly clock: Clock;
}) => {
    const { latest, weekAgo, requests, computer, clock } = options;
    const lifetime = new AbortController();
    let reading: AbortController | null = null;

    return createStore<ComputerReleaseStore>()((set, get) => {
        const read = async (target: string, signal: AbortSignal): Promise<void> => {
            for (const delay of RELEASE_READ_DELAYS_MILLISECONDS) {
                if (delay > 0) {
                    await clock.sleep(delay, signal);
                }
                try {
                    const { version } = await requests.daemonDiagnostics(
                        AbortSignal.any([signal, AbortSignal.timeout(RELEASE_READ_TIMEOUT_MILLISECONDS)]),
                    );
                    set({ state: nextReleaseState(get().state, version, target, weekAgo) });
                    return;
                } catch {
                    signal.throwIfAborted();
                }
            }
        };

        const check = (): void => {
            reading?.abort(new DOMException("A newer read of the Computer's release started.", "AbortError"));
            reading = null;
            if (computer.getState().computerConfiguration?.computer.online !== true || latest === null) {
                return;
            }
            reading = new AbortController();
            void read(latest, AbortSignal.any([lifetime.signal, reading.signal])).catch(() => undefined);
        };

        return {
            state: { kind: "unknown" },
            check,
            dispose: () => lifetime.abort(new DOMException("The chat workspace closed.", "AbortError")),
        };
    });
};

export type ComputerReleaseStoreApi = ReturnType<typeof createComputerReleaseStore>;
