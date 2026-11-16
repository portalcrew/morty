import { MortyError } from "@portalcrew/morty-client";
import { isApiConnectionError } from "../../services/api/worker-api-transport.ts";
import type { BotChatApi, BotComputerConfiguration } from "../../services/chat/bot-chat-api.ts";
import { isComputerConnectionFailure } from "../../services/management/management-api.ts";
import type { Clock } from "../../services/time/clock.ts";
import { formatError } from "../format-error.ts";
import type { ComputerObservation } from "./computer-recovery.ts";
import {
    type ComputerEntryOutcome,
    type ComputerStatusStoreApi,
    computerEntryOutcome,
} from "./computer-status-store.ts";
import { startRecoveryNotice } from "./recovery-notice.ts";

export const COMPUTER_REVOKED_MESSAGE = "This computer was disconnected. Run Morty setup on it again to reconnect.";

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
    readonly onReplaced: () => void;
    readonly retry: () => void;
    readonly onRestart: () => void;
    /** Announced when the entry failed only because the Computer was unreachable and waits for it to be retried. */
    readonly onWaitingForComputer: () => void;
}

export interface ComputerFollower {
    readonly follow: (signal: AbortSignal) => Promise<void>;
    readonly entered: (signal: AbortSignal) => Promise<ComputerEntryOutcome>;
    readonly interrupted: () => void;
    /**
     * An operation reported the pairing revoked, so the page's last pairing read may predate it. Waiting starts from a
     * read after it; one that already differs means setup is pairing again.
     */
    readonly revokedByOperation: (message: string, signal: AbortSignal) => Promise<void>;
}

export function createComputerFollower(ports: ComputerFollowerPorts): ComputerFollower {
    const { requests, computer, clock } = ports;
    let answered = Promise.withResolvers<void>();
    let attempt: AbortController | null = null;
    let recoveryNotice: AbortController | null = null;
    let current: AbortSignal | null = null;

    const settle = (): void => {
        const outcome = computerEntryOutcome(computer.getState());
        if (outcome !== null) {
            answered.resolve();
            ports.onEntered(outcome);
        }
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
        settle();
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
        entered: async (signal) => {
            signal.throwIfAborted();
            let outcome = computerEntryOutcome(computer.getState());
            while (outcome === null) {
                const waiting = answered.promise;
                await new Promise<void>((resolve, reject) => {
                    const aborted = () => reject(signal.reason);
                    signal.addEventListener("abort", aborted, { once: true });
                    void waiting.then(resolve).finally(() => signal.removeEventListener("abort", aborted));
                });
                outcome = computerEntryOutcome(computer.getState());
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
            answered = Promise.withResolvers<void>();
            current = signal;
            computer.getState().entryStarted();
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
                                settle();
                                await requests.waitForComputerPairingChange(attemptSignal);
                                signal.throwIfAborted();
                                ports.retry();
                                return;
                            }
                            if (unpaired) {
                                ports.retry();
                                return;
                            }
                            if (!entryDone) {
                                const configuration = await requests.computerConfiguration(attemptSignal);
                                attemptSignal.throwIfAborted();
                                computer.getState().entryReady();
                                entryDone = true;
                                settle();
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
                                computer
                                    .getState()
                                    .entryFailed("unavailable", formatError(cause, "Chat is unavailable."));
                                settle();
                                return;
                            }
                            await clock.sleep(5000, signal);
                            dropped = true;
                            continue;
                        }
                        if (cause instanceof MortyError && cause.code === "computer_revoked") {
                            await revokedBy(cause.message, signal);
                            return;
                        }
                        if (cause instanceof MortyError && cause.code === "AGENT_REQUIRED") {
                            computer.getState().entryFailed("agent-required", cause.message);
                            settle();
                            await requests.waitForComputerConfigurationChange(signal);
                            signal.throwIfAborted();
                            ports.retry();
                            return;
                        }
                        const message = formatError(cause, "Chat is unavailable.");
                        if (isComputerConnectionFailure(cause)) {
                            // Only a failed read is eligible for automatic replay; it does not assert the Computer is offline.
                            computer.getState().entryFailed("computer", message);
                            settle();
                            ports.onWaitingForComputer();
                            entryDone = true;
                            dropped = true;
                            continue;
                        }
                        computer.getState().entryFailed("unavailable", message);
                        settle();
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
