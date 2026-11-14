import { ShieldAlert } from "lucide-react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { DeviceSummary } from "../../components/chat/device-list.tsx";
import { SidebarAccessNoticeCarousel } from "../../components/chat/sidebar-access-notice-carousel.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import type { LinkedDevice } from "../../services/identity/anonymous-identity-api.ts";
import { type AccessExpiryStore, visibleAccessNotice } from "../../view-models/chat/access-expiry-store.ts";
import { describeLinkedDevice } from "../../view-models/chat/access-presentation.ts";
import { type LinkedDevicesStore, newDevicesSince } from "../../view-models/chat/linked-devices-store.ts";
import { AccessNotice, SidebarAccessNoticeCard, sidebarAccessNoticeActionClassName } from "./access-term.tsx";

/** This browser's access card, included in the carousel only while that card has something to say. */
type SidebarAccessNotice = {
    readonly computerName: string;
    readonly onOpenDevices: () => void;
    readonly store: StoreApi<AccessExpiryStore>;
};

/** One newly joined device, on its own card. Got it marks every new device as seen. */
function NewDeviceCard({
    acknowledge,
    device,
    onReviewDevices,
}: {
    readonly acknowledge: () => void;
    readonly device: LinkedDevice;
    readonly onReviewDevices: () => void;
}) {
    return (
        <SidebarAccessNoticeCard
            actions={
                <>
                    <Button className={sidebarAccessNoticeActionClassName} onClick={acknowledge} size="xs">
                        Got it
                    </Button>
                    <Button
                        className={sidebarAccessNoticeActionClassName}
                        onClick={onReviewDevices}
                        size="xs"
                        variant="outline"
                    >
                        Devices
                    </Button>
                </>
            }
            body={<DeviceSummary device={describeLinkedDevice(device, "notice")} layout="notice" />}
            bodyClassName="max-sm:hidden"
            detail="Not you? Disconnect it in Devices."
            icon={ShieldAlert}
            label="New device connected"
            mobileTitleSuffix={device.label ?? "Unknown browser"}
            title="New device connected"
        />
    );
}

function deviceCards(acknowledge: () => void, joined: readonly LinkedDevice[], onReviewDevices: () => void) {
    return joined.map((device) => (
        <NewDeviceCard acknowledge={acknowledge} device={device} key={device.id} onReviewDevices={onReviewDevices} />
    ));
}

function AccessNoticeCard({ access }: { readonly access: SidebarAccessNotice }) {
    return (
        <AccessNotice computerName={access.computerName} onOpenDevices={access.onOpenDevices} store={access.store} />
    );
}

/**
 * Each device that joined since this browser last looked is its own card. The access notice, if any, follows those
 * cards in the same carousel. Subscribes here so the access card joins only while it has something to say.
 */
export function NewDeviceNotice({
    access,
    onReviewDevices,
    store,
}: {
    /** This browser's access card. */
    readonly access: SidebarAccessNotice;
    /** Opens the devices with access, where any of them can be disconnected. */
    readonly onReviewDevices: () => void;
    readonly store: StoreApi<LinkedDevicesStore>;
}) {
    const { state, acknowledge } = useStore(store);
    const accessState = useStore(access.store, (model) => model.state);
    // The access term arrives on its own. A device card shown before that sits outside the carousel,
    // then moves when the access card joins. Wait until this read settles so the card stays put.
    if (accessState.kind === "unknown") {
        return null;
    }
    const shown = visibleAccessNotice(accessState);
    return (
        <SidebarAccessNoticeCarousel>
            {deviceCards(acknowledge, newDevicesSince(state.devices, state.seenAt), onReviewDevices)}
            {shown !== null ? <AccessNoticeCard access={access} /> : null}
        </SidebarAccessNoticeCarousel>
    );
}
