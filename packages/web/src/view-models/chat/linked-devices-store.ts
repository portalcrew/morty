import { createStore } from "zustand/vanilla";
import type { LinkedDevice } from "../../services/identity/anonymous-identity-api.ts";
import { centralLocalStorage, linkedDevicesSeenEntry } from "../../services/local-storage/central-local-storage.ts";
import type { Clock } from "../../services/time/clock.ts";

interface LinkedDevicesState {
    readonly devices: readonly LinkedDevice[] | null;
    readonly failed: boolean;
    readonly seenAt: string | null;
}

export interface LinkedDevicesStore {
    readonly state: LinkedDevicesState;
    readonly onAttach: (node: HTMLElement | null) => (() => void) | undefined;
    readonly refresh: () => void;
    readonly acknowledge: () => void;
}

function latestJoin(devices: readonly LinkedDevice[]): string {
    return devices.reduce(
        (latest, device) => (Date.parse(device.joinedAt) > Date.parse(latest) ? device.joinedAt : latest),
        new Date(0).toISOString(),
    );
}

export function newDevicesSince(
    devices: readonly LinkedDevice[] | null,
    seenAt: string | null,
): readonly LinkedDevice[] {
    if (devices === null || seenAt === null) {
        return [];
    }
    return devices.filter((device) => Date.parse(device.joinedAt) > Date.parse(seenAt));
}

/**
 * The page's one copy of the devices that hold access to this computer through a link, and of when this browser last
 * looked at them. The new-device notice and the Devices list both show it. Joining times come from the Worker, so
 * this browser's clock does not decide what is new; a browser is not told about devices that joined before it first
 * looked.
 */
export function createLinkedDevicesStore(options: {
    readonly computerId: string;
    readonly linkedDevices: (signal: AbortSignal) => Promise<readonly LinkedDevice[]>;
    readonly waitForChange: (signal: AbortSignal) => Promise<void>;
    readonly clock: Clock;
}) {
    const seen = linkedDevicesSeenEntry(options.computerId);
    return createStore<LinkedDevicesStore>()((set, get) => {
        let restart: (() => void) | null = null;
        const read = async (signal: AbortSignal): Promise<boolean> => {
            let devices: readonly LinkedDevice[];
            try {
                devices = await options.linkedDevices(AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
            } catch {
                if (!signal.aborted) {
                    set({ state: { ...get().state, failed: true } });
                }
                return false;
            }
            if (signal.aborted) {
                return false;
            }
            const seenAt = centralLocalStorage.read(seen) ?? latestJoin(devices);
            centralLocalStorage.write(seen, seenAt);
            set({ state: { devices, failed: false, seenAt } });
            return true;
        };
        /**
         * Waits until the list may differ: the Relay tells when a device joins or an access ends, but a device whose
         * access runs out changes nothing there, so the list is read again when the earliest term ends.
         */
        const nextChange = async (signal: AbortSignal): Promise<void> => {
            const now = options.clock.now();
            const terms = (get().state.devices ?? [])
                .map((device) => Date.parse(device.accessExpiresAt))
                .filter((term) => term > now);
            if (terms.length === 0) {
                await options.waitForChange(signal);
                return;
            }
            const settled = new AbortController();
            const waiting = AbortSignal.any([signal, settled.signal]);
            const changed = options.waitForChange(waiting);
            const expired = options.clock.sleep(Math.min(...terms) - now, waiting);
            changed.catch(() => undefined);
            expired.catch(() => undefined);
            try {
                await Promise.race([changed, expired]);
            } finally {
                settled.abort();
            }
        };
        /**
         * Reads, then reads again whenever the list differs from that read, until the page is hidden. A list that
         * cannot be read stops following: the watch would otherwise report that same difference again at once.
         */
        const follow = async (signal: AbortSignal): Promise<void> => {
            while (await read(signal)) {
                try {
                    await nextChange(signal);
                } catch {
                    return;
                }
            }
        };
        return {
            state: { devices: null, failed: false, seenAt: centralLocalStorage.read(seen) },
            onAttach: (node) => {
                if (node === null) {
                    return;
                }
                const lifetime = new AbortController();
                // A hidden page needs no live list; it reads again once it is visible.
                let visible: AbortController | null = null;
                const followWhileVisible = () => {
                    visible?.abort();
                    visible = null;
                    if (document.visibilityState === "visible") {
                        visible = new AbortController();
                        void follow(AbortSignal.any([lifetime.signal, visible.signal]));
                    }
                };
                document.addEventListener("visibilitychange", followWhileVisible, { signal: lifetime.signal });
                followWhileVisible();
                restart = followWhileVisible;
                return () => {
                    restart = null;
                    lifetime.abort();
                };
            },
            refresh: () => restart?.(),
            acknowledge: () => {
                const devices = get().state.devices;
                if (devices === null || newDevicesSince(devices, get().state.seenAt).length === 0) {
                    return;
                }
                const seenAt = latestJoin(devices);
                centralLocalStorage.write(seen, seenAt);
                set({ state: { ...get().state, seenAt } });
            },
        };
    });
}
