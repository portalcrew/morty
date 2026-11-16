import { createStore } from "zustand/vanilla";

export type DisconnectTarget =
    | { readonly kind: "device"; readonly id: string; readonly name: string }
    | { readonly kind: "others" };

type Disconnection =
    | { readonly kind: "idle" }
    | { readonly kind: "confirming" | "disconnecting" | "failed"; readonly target: DisconnectTarget };

/** What the last finished disconnection reached; a device's name is kept because it has left the list by then. */
type Disconnected = { readonly kind: "device"; readonly name: string } | { readonly kind: "others" };

type DeviceAccessState =
    | { readonly kind: "closed" }
    | { readonly kind: "open"; readonly disconnection: Disconnection; readonly disconnected: Disconnected | null };

export interface DeviceAccessStore {
    readonly state: DeviceAccessState;
    readonly open: () => void;
    readonly close: () => void;
    readonly request: (target: DisconnectTarget) => void;
    readonly cancel: () => void;
    readonly confirm: (signal: AbortSignal) => Promise<void>;
}

/**
 * The Devices list's disconnections. The devices themselves are the page's one linked-device list: this store only
 * asks it to read again, when the list opens and after a disconnection changed it.
 */
export function createDeviceAccessStore(options: {
    readonly endDeviceAccess: (deviceId: string, signal: AbortSignal) => Promise<void>;
    readonly endOtherBrowserAccess: (signal: AbortSignal) => Promise<void>;
    readonly readDevices: () => void;
}) {
    return createStore<DeviceAccessStore>()((set, get) => {
        const update = (
            change: (state: Extract<DeviceAccessState, { readonly kind: "open" }>) => DeviceAccessState,
        ) => {
            const state = get().state;
            if (state.kind === "open") {
                set({ state: change(state) });
            }
        };
        return {
            state: { kind: "closed" },
            open: () => {
                set({ state: { kind: "open", disconnection: { kind: "idle" }, disconnected: null } });
                options.readDevices();
            },
            close: () => {
                const state = get().state;
                if (state.kind === "open" && state.disconnection.kind !== "disconnecting") {
                    set({ state: { kind: "closed" } });
                }
            },
            request: (target) => update((state) => ({ ...state, disconnection: { kind: "confirming", target } })),
            cancel: () =>
                update((state) =>
                    state.disconnection.kind === "disconnecting"
                        ? state
                        : { ...state, disconnection: { kind: "idle" } },
                ),
            confirm: async (signal) => {
                const state = get().state;
                if (
                    state.kind !== "open" ||
                    (state.disconnection.kind !== "confirming" && state.disconnection.kind !== "failed")
                ) {
                    return;
                }
                const target = state.disconnection.target;
                update((current) => ({ ...current, disconnection: { kind: "disconnecting", target } }));
                const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
                try {
                    if (target.kind === "device") {
                        await options.endDeviceAccess(target.id, bounded);
                    } else {
                        await options.endOtherBrowserAccess(bounded);
                    }
                    signal.throwIfAborted();
                    update((current) => ({
                        ...current,
                        disconnection: { kind: "idle" },
                        disconnected:
                            target.kind === "device" ? { kind: "device", name: target.name } : { kind: "others" },
                    }));
                    options.readDevices();
                } catch {
                    // Access that no longer opens the computer may have ended this page's workspace, and this store with it.
                    if (!signal.aborted) {
                        update((current) => ({ ...current, disconnection: { kind: "failed", target } }));
                    }
                }
            },
        };
    });
}
