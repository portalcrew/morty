import { MortyOperationError } from "@portalcrew/morty-client";
import { isNewerMortyRelease } from "@portalcrew/morty-client/protocol";
import { createStore } from "zustand/vanilla";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import type { Clock } from "../../services/time/clock.ts";

/** Why the last update left the Computer on its release; the person may try again. */
type UpdateNotice = "busy" | "download" | "failed" | "incomplete";

export type ComputerUpdateState =
    | { readonly kind: "unknown" }
    | { readonly kind: "current"; readonly running: string }
    | {
          readonly kind: "available";
          readonly running: string;
          readonly latest: string;
          readonly remote: boolean;
          readonly notice: UpdateNotice | null;
      }
    | { readonly kind: "updating"; readonly running: string; readonly latest: string }
    | { readonly kind: "restarting"; readonly running: string; readonly latest: string }
    | { readonly kind: "updated"; readonly version: string };

export interface ComputerUpdateStore {
    readonly state: ComputerUpdateState;
    /** Announced with each Computer configuration; a Computer that comes online is asked which release it runs. */
    readonly observe: (online: boolean) => void;
    readonly update: () => Promise<void>;
    readonly dispose: () => void;
}

const RESTART_DEADLINE_MILLISECONDS = 240_000;
const RESTART_CHECK_INTERVAL_MILLISECONDS = 3_000;
const RELEASE_READ_TIMEOUT_MILLISECONDS = 15_000;

function releaseState(latest: string, running: string, remote: boolean): ComputerUpdateState {
    return isNewerMortyRelease(latest, running)
        ? { kind: "available", running, latest, remote, notice: null }
        : { kind: "current", running };
}

function refusalNotice(code: string): UpdateNotice {
    switch (code) {
        case "computer_busy":
            return "busy";
        case "update_download_failed":
        case "update_npx_unavailable":
            return "download";
        default:
            return "failed";
    }
}

export const createComputerUpdateStore = (options: {
    readonly latest: string | null;
    readonly requests: Pick<BotChatApi, "daemonDiagnostics" | "updateComputer">;
    readonly clock: Clock;
}) => {
    const { latest, requests, clock } = options;
    const lifetime = new AbortController();
    let online = false;

    const readRelease = async (): Promise<{ readonly running: string; readonly remote: boolean }> => {
        const diagnostics = await requests.daemonDiagnostics(
            AbortSignal.any([lifetime.signal, AbortSignal.timeout(RELEASE_READ_TIMEOUT_MILLISECONDS)]),
        );
        return { running: diagnostics.version, remote: diagnostics.remoteUpdate === "supported" };
    };

    return createStore<ComputerUpdateStore>()((set, get) => {
        const settleRestart = async (running: string, target: string): Promise<void> => {
            const deadline = clock.now() + RESTART_DEADLINE_MILLISECONDS;
            // Until the Computer has been unreachable, an earlier release answering is the one still stopping.
            let restarted = false;
            while (clock.now() < deadline) {
                await clock.sleep(RESTART_CHECK_INTERVAL_MILLISECONDS, lifetime.signal);
                try {
                    const release = await readRelease();
                    if (!isNewerMortyRelease(target, release.running)) {
                        set({ state: { kind: "updated", version: release.running } });
                        return;
                    }
                    if (restarted) {
                        set({
                            state: {
                                kind: "available",
                                running: release.running,
                                latest: target,
                                remote: release.remote,
                                notice: "incomplete",
                            },
                        });
                        return;
                    }
                } catch {
                    lifetime.signal.throwIfAborted();
                    restarted = true;
                }
            }
            set({ state: { kind: "available", running, latest: target, remote: true, notice: "incomplete" } });
        };

        return {
            state: { kind: "unknown" },
            observe: (nowOnline) => {
                const cameOnline = nowOnline && !online;
                online = nowOnline;
                const state = get().state;
                if (!cameOnline || latest === null || state.kind === "updating" || state.kind === "restarting") {
                    return;
                }
                void readRelease().then(
                    (release) => {
                        const current = get().state;
                        if (current.kind !== "updating" && current.kind !== "restarting") {
                            set({ state: releaseState(latest, release.running, release.remote) });
                        }
                    },
                    () => undefined,
                );
            },
            update: async () => {
                const state = get().state;
                if (state.kind !== "available" || !state.remote) {
                    return;
                }
                const { running, latest: target } = state;
                set({ state: { kind: "updating", running, latest: target } });
                try {
                    await requests.updateComputer(target, lifetime.signal);
                } catch (cause) {
                    lifetime.signal.throwIfAborted();
                    if (cause instanceof MortyOperationError && cause.code === "update_not_newer") {
                        // An earlier request whose reply was lost already updated the Computer.
                        const release = await readRelease().catch(() => null);
                        set({
                            state: release === null ? state : releaseState(target, release.running, release.remote),
                        });
                        return;
                    }
                    // Another device's update already runs, so this page follows its outcome as its own.
                    if (
                        cause instanceof MortyOperationError &&
                        cause.outcome !== "unknown" &&
                        cause.code !== "update_in_progress"
                    ) {
                        set({ state: { ...state, notice: refusalNotice(cause.code) } });
                        return;
                    }
                    // A lost reply leaves the Computer possibly restarting anyway; its release says which.
                }
                set({ state: { kind: "restarting", running, latest: target } });
                await settleRestart(running, target);
            },
            dispose: () => lifetime.abort(new DOMException("The chat workspace closed.", "AbortError")),
        };
    });
};

export type ComputerUpdateStoreApi = ReturnType<typeof createComputerUpdateStore>;
