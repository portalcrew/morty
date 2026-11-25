import { createStore } from "zustand/vanilla";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import { isNewerMortyRelease } from "../../services/release/morty-release.ts";
import type { Clock } from "../../services/time/clock.ts";

type ComputerReleaseState =
    | { readonly kind: "unknown" }
    | { readonly kind: "current"; readonly running: string }
    | { readonly kind: "outdated"; readonly running: string; readonly latest: string }
    // This page saw the Computer move from an older release to the latest one.
    | { readonly kind: "updated"; readonly running: string };

export interface ComputerReleaseStore {
    readonly state: ComputerReleaseState;
    /** Announced with each Computer configuration; a Computer that comes online is asked which release it runs. */
    readonly observe: (online: boolean) => void;
    readonly dispose: () => void;
}

const RELEASE_READ_TIMEOUT_MILLISECONDS = 15_000;
// A read can fail while the Computer is still settling in; spaced retries recover it without a reload.
const RELEASE_READ_DELAYS_MILLISECONDS = [0, 5_000, 15_000, 45_000];

export const createComputerReleaseStore = (options: {
    readonly latest: string | null;
    readonly requests: Pick<BotChatApi, "daemonDiagnostics">;
    readonly clock: Clock;
}) => {
    const { latest, requests, clock } = options;
    const lifetime = new AbortController();
    let online = false;
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
                    set({
                        state: isNewerMortyRelease(target, version)
                            ? { kind: "outdated", running: version, latest: target }
                            : get().state.kind === "outdated"
                              ? { kind: "updated", running: version }
                              : { kind: "current", running: version },
                    });
                    return;
                } catch {
                    signal.throwIfAborted();
                }
            }
        };

        return {
            state: { kind: "unknown" },
            observe: (nowOnline) => {
                const cameOnline = nowOnline && !online;
                online = nowOnline;
                if (!nowOnline) {
                    reading?.abort(new DOMException("The Computer went offline.", "AbortError"));
                    reading = null;
                }
                if (!cameOnline || latest === null) {
                    return;
                }
                reading = new AbortController();
                void read(latest, AbortSignal.any([lifetime.signal, reading.signal])).catch(() => undefined);
            },
            dispose: () => lifetime.abort(new DOMException("The chat workspace closed.", "AbortError")),
        };
    });
};

export type ComputerReleaseStoreApi = ReturnType<typeof createComputerReleaseStore>;
