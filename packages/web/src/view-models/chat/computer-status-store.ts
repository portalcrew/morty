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

/** How the page's follow of the Computer's configuration stands. */
type ConfigurationWatch =
    | { readonly kind: "checking" }
    | { readonly kind: "current"; readonly checkedAt: number }
    | {
          readonly kind: "unavailable";
          readonly lastCheckedAt: number | null;
          readonly notice: "quiet" | "visible";
      };

export type BotConnectionStatus =
    | { readonly kind: "connecting"; readonly label: "Connecting" }
    | { readonly kind: "connected"; readonly label: "Connected" }
    | { readonly kind: "unavailable"; readonly label: "Unavailable" }
    | { readonly kind: "unpaired"; readonly label: "Disconnected" }
    | { readonly kind: "revoked"; readonly label: "Disconnected" }
    | { readonly kind: "disconnected"; readonly label: "Disconnected" };

/**
 * What the page knows of its Computer: whether it is paired, the configuration the page follows, how that follow stands
 * and whether the browser has a network. Conversations, drafts and the Session on screen are other stores'; they read
 * this one and never write it.
 */
export interface ComputerStatusStore {
    readonly pairing: BotPairing;
    readonly computerConfiguration: BotComputerConfiguration | null;
    readonly configurationWatch: ConfigurationWatch;
    readonly networkAvailable: boolean;
    /** Whether the pairing instructions show, independently of the pairing it follows. */
    readonly pairingDialog: ReturnType<typeof createPairingDialogStore>;
    readonly networkChanged: (available: boolean) => void;
    readonly pairingRead: (pairing: "paired" | "unpaired") => void;
    readonly pairingRevoked: () => void;
    /** The Computer's configuration as the Computer last reported it, read or watched at `checkedAt`. */
    readonly configurationObserved: (configuration: BotComputerConfiguration, checkedAt: number) => void;
    /**
     * The follow was interrupted. Returns the notice the interruption starts with: an established follow recovers
     * quietly, one that never was current says so at once, and a continuing interruption keeps its notice.
     */
    readonly watchInterrupted: () => "quiet" | "visible";
    /** An interruption's notice changed while the follow stays unavailable. */
    readonly interruptionNoticed: (notice: "quiet" | "visible") => void;
    /** Nothing recovers the interruption any more, so it asks the user to retry at once. */
    readonly interruptionUnattended: () => void;
}

export const createComputerStatusStore = (networkAvailable: boolean) =>
    createStore<ComputerStatusStore>()((set, get) => ({
        pairing: { kind: "checking" },
        computerConfiguration: null,
        configurationWatch: { kind: "checking" },
        networkAvailable,
        pairingDialog: createPairingDialogStore(),
        networkChanged: (available) => set({ networkAvailable: available }),
        pairingRead: (pairing) => set({ pairing: { kind: pairing } }),
        pairingRevoked: () => set({ pairing: { kind: "revoked" } }),
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
        return { kind: "unpaired", label: "Disconnected" };
    }
    if (computer.pairing.kind === "revoked") {
        return { kind: "revoked", label: "Disconnected" };
    }
    if (!computer.networkAvailable || computer.configurationWatch.kind === "unavailable") {
        return { kind: "unavailable", label: "Unavailable" };
    }
    if (computer.computerConfiguration !== null) {
        return computer.computerConfiguration.computer.online
            ? { kind: "connected", label: "Connected" }
            : { kind: "disconnected", label: "Disconnected" };
    }
    return { kind: "connecting", label: "Connecting" };
}
