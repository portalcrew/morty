import { isApiConnectionError } from "../../services/api/worker-api-transport.ts";
import type { BotChatApi, BotComputerConfiguration } from "../../services/chat/bot-chat-api.ts";
import { CloudApiError, isComputerConnectionFailure } from "../../services/management/management-api.ts";
import type { Clock } from "../../services/time/clock.ts";
import { formatError } from "../format-error.ts";
import type { ComputerObservation } from "./computer-recovery.ts";
import type { ComputerStatusStoreApi } from "./computer-status-store.ts";
import { startRecoveryNotice } from "./recovery-notice.ts";

/** Why a Session that waits on a revoked Computer fails. */
export const COMPUTER_REVOKED_MESSAGE = "This computer was disconnected. Run Morty setup on it again to reconnect.";

/** How the Computer answered the page's entry request, as the Session load waiting on it needs to know. */
export type ComputerEntryOutcome =
    | { readonly kind: "paired" }
    | { readonly kind: "unpaired" }
    | { readonly kind: "revoked" }
    /** The request failed; the Computer's status holds why. */
    | { readonly kind: "failed" };

/**
 * The collaborators the follower announces to. The follower owns what the page reads from the Computer itself: its
 * pairing, its configuration, and how that follow stands. It never touches conversations, drafts or selections.
 */
export interface ComputerFollowerPorts {
    readonly requests: Pick<
        BotChatApi,
        | "computerConfiguration"
        | "readComputerPairing"
        | "waitForComputerConfigurationChange"
        | "waitForComputerPairingChange"
    >;
    readonly computer: ComputerStatusStoreApi;
    readonly clock: Clock;
    /** Whether the New Session draft is selected, whose view follows the configuration as soon as it can. */
    readonly draftSelected: () => boolean;
    /**
     * Announced with every Computer configuration the page observes, after the Computer's status follows it: the owner
     * keeps the other workspace workflows on it and retries what the Computer failed once it is back.
     */
    readonly onConfiguration: (configuration: BotComputerConfiguration, observation: ComputerObservation) => void;
    /**
     * Announced the moment the Computer answers the entry request, before anything else the answer changes is seen: the
     * owner moves the selection the request was for in the same step, so the page never shows an answered Computer
     * beside a selection that still waits for it.
     */
    readonly onEntered: (outcome: ComputerEntryOutcome) => void;
    /** Announced when the pairing was revoked, so a Session still loading for it fails. */
    readonly onRevoked: (message: string) => void;
    /** Announced once setup pairs the Computer again after revocation: the owner starts the page over. */
    readonly onReplaced: () => void;
    /** Announced when the Computer's entry completes only by starting the page over, as after setup. */
    readonly retry: () => void;
    /** Announced when a read timed out and the page starts over. */
    readonly onRestart: () => void;
    /** Announced when the entry failed only because the Computer was unreachable and waits for it to be retried. */
    readonly onWaitingForComputer: () => void;
}

export interface ComputerFollower {
    /**
     * Follows the Computer until `signal` ends: reads its pairing and configuration, then watches the configuration and
     * recovers from interruptions. Each call starts the entry request again.
     */
    readonly follow: (signal: AbortSignal) => Promise<void>;
    /** How the Computer answered the current entry request, or null while it has not. */
    readonly entry: () => ComputerEntryOutcome | null;
    /** Resolves with how the Computer answered the current entry request, as soon as it did. */
    readonly entered: (signal: AbortSignal) => Promise<ComputerEntryOutcome>;
    /** An operation through the Computer failed for connectivity: the follow recovers from the start. */
    readonly interrupted: () => void;
    /**
     * An operation reported the pairing revoked, so the page's last pairing read may predate it. Waiting starts from a
     * read after it; one that already differs means setup is pairing again.
     */
    readonly revokedByOperation: (message: string, signal: AbortSignal) => Promise<void>;
}

export function createComputerFollower(ports: ComputerFollowerPorts): ComputerFollower {
    const { requests, computer, clock } = ports;
    let outcome: ComputerEntryOutcome | null = null;
    let answered = Promise.withResolvers<void>();
    // The attempt the follow is in now; ending it makes the follow recover from the start.
    let attempt: AbortController | null = null;
    let recoveryNotice: AbortController | null = null;
    let current: AbortSignal | null = null;

    const settle = (next: ComputerEntryOutcome): void => {
        outcome = next;
        answered.resolve();
        ports.onEntered(next);
    };
    const clearRecoveryNotice = (): void => {
        recoveryNotice?.abort();
        recoveryNotice = null;
    };
    const configurationUnavailable = (): void => {
        // Repeated failures belong to one interruption, so they cannot postpone its notice.
        if (recoveryNotice !== null || current === null) {
            return;
        }
        if (computer.getState().watchInterrupted() === "visible") {
            return;
        }
        recoveryNotice = startRecoveryNotice({
            clock,
            signal: current,
            onNotice: (notice) => computer.getState().interruptionNoticed(notice),
        });
    };
    /** Records the authoritative snapshot and announces it to the other workspace workflows. */
    const observe = (configuration: BotComputerConfiguration, observation: ComputerObservation): void => {
        clearRecoveryNotice();
        computer.getState().configurationObserved(configuration, clock.now());
        ports.onConfiguration(configuration, observation);
    };
    /**
     * The Computer's pairing was revoked. The page says so, and starts over once setup pairs it again: every Session
     * connection it opened belongs to the revoked pairing.
     */
    const awaitReplacement = async (message: string, signal: AbortSignal): Promise<void> => {
        computer.getState().pairingRevoked();
        computer.getState().entryReady();
        // The message names why, so it reaches a loading Session before the answer's own generic one.
        ports.onRevoked(message);
        settle({ kind: "revoked" });
        await requests.waitForComputerPairingChange(signal);
        signal.throwIfAborted();
        ports.onReplaced();
    };
    /**
     * An operation reported the pairing revoked, so the page's last pairing read may predate it. Waiting starts from a
     * read after it; one that already differs means setup is pairing again.
     */
    const revokedBy = async (message: string, signal: AbortSignal): Promise<void> => {
        const pairing = await requests.readComputerPairing(signal);
        signal.throwIfAborted();
        if (pairing !== "revoked") {
            ports.onReplaced();
            return;
        }
        await awaitReplacement(message, signal);
    };
    /**
     * Watches the Computer configuration. Each watch adopts its comparison baseline as the snapshot, so a brief change
     * between two reads cannot leave the page stale. `baselineFollowsChange` says the first baseline may already differ
     * from what the page last saw, as after a network outage.
     */
    const watch = async (signal: AbortSignal, baselineFollowsChange: boolean): Promise<void> => {
        let afterChange = baselineFollowsChange;
        while (true) {
            try {
                await requests.waitForComputerConfigurationChange(signal, (configuration) => {
                    signal.throwIfAborted();
                    if (ports.draftSelected()) {
                        // A recovered configuration read completes draft entry after a network outage.
                        computer.getState().entryReady();
                    }
                    observe(configuration, { kind: "watch", afterChange });
                });
            } catch (cause) {
                if (cause instanceof DOMException && cause.name === "TimeoutError") {
                    continue;
                }
                throw cause;
            }
            signal.throwIfAborted();
            afterChange = true;
        }
    };

    return {
        entry: () => outcome,
        entered: async (signal) => {
            signal.throwIfAborted();
            while (outcome === null) {
                const waiting = answered.promise;
                await new Promise<void>((resolve, reject) => {
                    const aborted = () => reject(signal.reason);
                    signal.addEventListener("abort", aborted, { once: true });
                    void waiting.then(resolve).finally(() => signal.removeEventListener("abort", aborted));
                });
            }
            return outcome;
        },
        interrupted: () => {
            configurationUnavailable();
            attempt?.abort(new DOMException("The Computer follow recovers.", "AbortError"));
        },
        revokedByOperation: revokedBy,
        follow: async (signal) => {
            signal.throwIfAborted();
            outcome = null;
            answered = Promise.withResolvers<void>();
            current = signal;
            computer.getState().entryStarted();
            // The entry request is done once the configuration was read or the Computer answered it with a failure.
            let entryDone = false;
            let unpaired = false;
            let dropped = true;
            let rearmed = false;
            try {
                while (true) {
                    const own = new AbortController();
                    attempt = own;
                    const attemptSignal = AbortSignal.any([signal, own.signal]);
                    try {
                        if (dropped) {
                            const pairing = await requests.readComputerPairing(attemptSignal);
                            attemptSignal.throwIfAborted();
                            if (pairing === "revoked") {
                                await awaitReplacement(COMPUTER_REVOKED_MESSAGE, signal);
                                return;
                            }
                            computer.getState().pairingRead(pairing);
                            if (pairing === "unpaired") {
                                unpaired = true;
                                computer.getState().pairingDialog.getState().show();
                                computer.getState().entryReady();
                                settle({ kind: "unpaired" });
                                // An unpaired Computer waits for the pairing it just read to change; the pairing flow
                                // completes by starting the page over.
                                await requests.waitForComputerPairingChange(attemptSignal);
                                signal.throwIfAborted();
                                ports.retry();
                                return;
                            }
                            if (unpaired) {
                                // Pairing completed during an outage. Finish setup just as a pairing notification would,
                                // including draft settings and the directory.
                                ports.retry();
                                return;
                            }
                            if (!entryDone) {
                                const configuration = await requests.computerConfiguration(attemptSignal);
                                attemptSignal.throwIfAborted();
                                computer.getState().entryReady();
                                entryDone = true;
                                settle({ kind: "paired" });
                                observe(configuration, { kind: "read" });
                                computer.getState().pairingDialog.getState().dismiss();
                            }
                            dropped = false;
                        }
                        // A bound Computer keeps following workspace changes even while its Computer is offline. A watch
                        // armed again after an outage may find a Computer that changed meanwhile.
                        const baselineFollowsChange = rearmed;
                        rearmed = true;
                        await watch(attemptSignal, baselineFollowsChange);
                        return;
                    } catch (cause) {
                        signal.throwIfAborted();
                        if (own.signal.aborted) {
                            // An operation reported the Computer unreachable: recover from the pairing read.
                            dropped = true;
                            continue;
                        }
                        if (cause instanceof DOMException && cause.name === "TimeoutError") {
                            ports.onRestart();
                            return;
                        }
                        if (isApiConnectionError(cause)) {
                            console.error("The Morty API request failed.", cause);
                            configurationUnavailable();
                            if (!entryDone && !ports.draftSelected()) {
                                // The request a Session load waits on failed: it becomes an operable failure.
                                computer
                                    .getState()
                                    .entryFailed("unavailable", formatError(cause, "Chat is unavailable."));
                                settle({ kind: "failed" });
                                return;
                            }
                            await clock.sleep(5000, signal);
                            dropped = true;
                            continue;
                        }
                        if (cause instanceof CloudApiError && cause.code === "computer_revoked") {
                            await revokedBy(cause.message, signal);
                            return;
                        }
                        if (cause instanceof CloudApiError && cause.code === "AGENT_REQUIRED") {
                            computer.getState().entryFailed("agent-required", cause.message);
                            settle({ kind: "failed" });
                            await requests.waitForComputerConfigurationChange(signal);
                            signal.throwIfAborted();
                            ports.retry();
                            return;
                        }
                        const message = formatError(cause, "Chat is unavailable.");
                        if (isComputerConnectionFailure(cause)) {
                            // Only a failed read is eligible for automatic replay; it does not assert the Computer is offline.
                            computer.getState().entryFailed("computer", message);
                            settle({ kind: "failed" });
                            ports.onWaitingForComputer();
                            entryDone = true;
                            dropped = true;
                            continue;
                        }
                        computer.getState().entryFailed("unavailable", message);
                        settle({ kind: "failed" });
                        return;
                    }
                }
            } finally {
                // Quiet feedback is owned by an active recovery. Once the follow exits, an unavailable watch needs the
                // manual retry entry point immediately.
                if (!signal.aborted) {
                    computer.getState().interruptionUnattended();
                }
                clearRecoveryNotice();
                if (current === signal) {
                    current = null;
                }
            }
        },
    };
}
