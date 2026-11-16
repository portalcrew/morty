import { createStore } from "zustand/vanilla";
import type { BotComputerConfiguration } from "../../services/chat/bot-chat-api.ts";
import { createPairingDialogStore } from "./pairing-dialog-store.ts";

/**
 * Whether the Computer is paired. `revoked`: a copy of its connection key was used,
 * and the owner must run setup on the Computer to pair it again.
 */
type BotPairing =
    | { readonly kind: "checking" }
    | { readonly kind: "paired" }
    | { readonly kind: "unpaired" }
    | { readonly kind: "revoked" };

/**
 * Whether the page's entry request to the Computer has been answered: its pairing read, and for a paired Computer its
 * configuration. It owns only that request, never the selected Session or the Computer's availability afterwards.
 * `reloading`: the Computer answered an earlier request and the page asks again; the page keeps showing that answer
 * while a Session load waits for the new one.
 */
type ComputerEntry =
    | { readonly kind: "loading" }
    | { readonly kind: "reloading" }
    | { readonly kind: "ready" }
    | {
          readonly kind: "failed";
          readonly failure: "computer" | "agent-required" | "unavailable";
          readonly message: string;
      };

type ConfigurationWatch =
    | { readonly kind: "checking" }
    | { readonly kind: "current"; readonly checkedAt: number }
    | {
          readonly kind: "unavailable";
          readonly lastCheckedAt: number | null;
          readonly notice: "quiet" | "visible";
      };

export type BotConnectionStatus = {
    readonly kind: "connecting" | "connected" | "unavailable" | "unpaired" | "revoked" | "disconnected";
};

/**
 * What the page knows of its Computer: whether it is paired, the configuration the page follows, how that follow stands
 * and whether the browser has a network. Conversations, drafts and the Session on screen are other stores'; they read
 * this one and never write it.
 */
export interface ComputerStatusStore {
    readonly pairing: BotPairing;
    readonly entry: ComputerEntry;
    readonly computerConfiguration: BotComputerConfiguration | null;
    readonly configurationWatch: ConfigurationWatch;
    readonly networkAvailable: boolean;
    readonly pairingDialog: ReturnType<typeof createPairingDialogStore>;
    readonly networkChanged: (available: boolean) => void;
    readonly pairingRead: (pairing: "paired" | "unpaired") => void;
    readonly pairingRevoked: () => void;
    readonly entryStarted: () => void;
    readonly entryReady: () => void;
    readonly entryFailed: (failure: "computer" | "agent-required" | "unavailable", message: string) => void;
    readonly configurationObserved: (configuration: BotComputerConfiguration, checkedAt: number) => void;
    /**
     * The follow was interrupted. Returns the notice the interruption starts with: an established follow recovers
     * quietly, one that never was current says so at once, and a continuing interruption keeps its notice.
     */
    readonly watchInterrupted: () => "quiet" | "visible";
    readonly interruptionNoticed: (notice: "quiet" | "visible") => void;
    /** Nothing recovers the interruption any more, so it asks the user to retry at once. */
    readonly interruptionUnattended: () => void;
}

export const createComputerStatusStore = (networkAvailable: boolean) =>
    createStore<ComputerStatusStore>()((set, get) => ({
        pairing: { kind: "checking" },
        entry: { kind: "loading" },
        computerConfiguration: null,
        configurationWatch: { kind: "checking" },
        networkAvailable,
        pairingDialog: createPairingDialogStore(),
        networkChanged: (available) => set({ networkAvailable: available }),
        pairingRead: (pairing) => set({ pairing: { kind: pairing } }),
        pairingRevoked: () => set({ pairing: { kind: "revoked" } }),
        entryStarted: () => {
            const entry = get().entry;
            set({ entry: { kind: entry.kind === "ready" || entry.kind === "reloading" ? "reloading" : "loading" } });
        },
        entryReady: () => set({ entry: { kind: "ready" } }),
        entryFailed: (failure, message) => set({ entry: { kind: "failed", failure, message } }),
        configurationObserved: (configuration, checkedAt) =>
            set({
                computerConfiguration: configuration,
                configurationWatch: { kind: "current", checkedAt },
            }),
        watchInterrupted: () => {
            const watch = get().configurationWatch;
            const notice = watch.kind === "current" ? "quiet" : watch.kind === "unavailable" ? watch.notice : "visible";
            set({
                configurationWatch: {
                    kind: "unavailable",
                    lastCheckedAt:
                        watch.kind === "current"
                            ? watch.checkedAt
                            : watch.kind === "unavailable"
                              ? watch.lastCheckedAt
                              : null,
                    notice,
                },
            });
            return notice;
        },
        interruptionNoticed: (notice) => {
            const watch = get().configurationWatch;
            if (watch.kind === "unavailable") {
                set({ configurationWatch: { ...watch, notice } });
            }
        },
        interruptionUnattended: () => {
            const watch = get().configurationWatch;
            if (watch.kind === "unavailable") {
                set({ configurationWatch: { ...watch, notice: "visible" } });
            }
        },
    }));

export type ComputerStatusStoreApi = ReturnType<typeof createComputerStatusStore>;

export type ComputerEntryOutcome =
    | { readonly kind: "paired" }
    | { readonly kind: "unpaired" }
    | { readonly kind: "revoked" }
    | { readonly kind: "failed" };

export function computerEntryOutcome(
    computer: Pick<ComputerStatusStore, "entry" | "pairing">,
): ComputerEntryOutcome | null {
    switch (computer.entry.kind) {
        case "loading":
        case "reloading":
            return null;
        case "failed":
            return { kind: "failed" };
        case "ready":
            return computer.pairing.kind === "checking" ? null : { kind: computer.pairing.kind };
        default:
            return computer.entry satisfies never;
    }
}

/**
 * The Computer's connection as the page shows it everywhere. It is derived from the Computer configuration the page
 * follows, so no failure path can leave one part of the page saying offline while another says online.
 */
export function botConnectionStatus(
    computer: Pick<
        ComputerStatusStore,
        "computerConfiguration" | "pairing" | "configurationWatch" | "networkAvailable"
    >,
): BotConnectionStatus {
    if (computer.pairing.kind === "unpaired") {
        return { kind: "unpaired" };
    }
    if (computer.pairing.kind === "revoked") {
        return { kind: "revoked" };
    }
    if (!computer.networkAvailable || computer.configurationWatch.kind === "unavailable") {
        return { kind: "unavailable" };
    }
    if (computer.computerConfiguration !== null) {
        return computer.computerConfiguration.computer.online ? { kind: "connected" } : { kind: "disconnected" };
    }
    return { kind: "connecting" };
}
