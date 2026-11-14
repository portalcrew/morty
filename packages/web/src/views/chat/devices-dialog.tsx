import { ChevronDown, Laptop } from "lucide-react";
import { Tooltip } from "radix-ui";
import type { ReactNode } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { DeviceSummary } from "../../components/chat/device-list.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import {
    Dialog,
    dialogBodyStackClassName,
    dialogPinnedFooterActionsClassName,
    dialogSectionTitleClassName,
} from "../../components/ui/dialog.tsx";
import { ExternalLink } from "../../components/ui/external-link.tsx";
import { LinkButton } from "../../components/ui/link-button.tsx";
import { MortyTooltipContent } from "../../components/ui/morty-tooltip-content.tsx";
import { mutedTextLinkClassName, textLinkClassName } from "../../components/ui/text-link.ts";
import { cn } from "../../lib/utils.ts";
import type { LinkedDevice } from "../../services/identity/anonymous-identity-api.ts";
import type { AccessExpiryStore } from "../../view-models/chat/access-expiry-store.ts";
import { describeLinkedDevice, formatMomentNumeric } from "../../view-models/chat/access-presentation.ts";
import type { DeviceAccessStore, DisconnectTarget } from "../../view-models/chat/device-access-store.ts";
import type { LinkedDevicesStore } from "../../view-models/chat/linked-devices-store.ts";
import { mortyRepository } from "../morty-repository.ts";

const dataPolicy = `${mortyRepository}#what-morty-does-with-your-data`;

const deviceGroupCardClassName = "overflow-hidden rounded-[20px] border border-white bg-card px-4 shadow-module";
const deviceGroupRowClassName = "py-3.5";
const deviceGroupDividerClassName = "border-t border-border/40 -mx-4 px-4";

type OpenState = Extract<DeviceAccessStore["state"], { readonly kind: "open" }>;

function targets(disconnection: OpenState["disconnection"], target: DisconnectTarget): boolean {
    return (
        disconnection.kind !== "idle" &&
        disconnection.target.kind === target.kind &&
        (target.kind === "others" || (disconnection.target.kind === "device" && disconnection.target.id === target.id))
    );
}

function disconnectConfirmFooter(
    disconnection: OpenState["disconnection"],
    cancel: () => void,
    confirm: () => void,
): ReactNode {
    const disconnecting = disconnection.kind === "disconnecting";
    return (
        <div className={dialogPinnedFooterActionsClassName}>
            <Button disabled={disconnecting} onClick={cancel} variant="ghost">
                Cancel
            </Button>
            <Button
                ref={(node) => {
                    node?.focus();
                }}
                disabled={disconnecting}
                onClick={confirm}
                variant="primary"
            >
                {disconnecting ? "Disconnecting…" : disconnection.kind === "failed" ? "Try again" : "Disconnect"}
            </Button>
        </div>
    );
}

function ThisBrowser({ accessExpiry }: { readonly accessExpiry: StoreApi<AccessExpiryStore> }) {
    const term = useStore(accessExpiry, (model) => model.state);
    const until = term.kind !== "known" ? null : term.expiresAt === null ? null : formatMomentNumeric(term.expiresAt);
    return (
        <DeviceSummary
            device={{
                name: "This browser",
                details:
                    until === null
                        ? term.kind === "known" && term.expiresAt === null
                            ? [{ kind: "text", text: "No time limit" }]
                            : []
                        : [{ kind: "fields", fields: [{ label: "Until", value: until }] }],
            }}
        />
    );
}

function OtherDevicesBody({
    list,
    refresh,
    row,
}: {
    readonly list: LinkedDevicesStore["state"];
    readonly refresh: () => void;
    readonly row: (device: LinkedDevice) => ReactNode;
}) {
    if (list.devices === null && !list.failed) {
        return (
            <p className={cn(deviceGroupRowClassName, "text-13 text-morty-text-3")} role="status">
                Checking which devices have access…
            </p>
        );
    }
    if (list.failed) {
        return (
            <div className={cn(deviceGroupRowClassName, "flex items-center justify-between gap-3")} role="alert">
                <span className="text-13 text-morty-text-3">We couldn't load your devices.</span>
                <Button onClick={refresh} variant="ghost">
                    Try again
                </Button>
            </div>
        );
    }
    if (list.devices !== null && list.devices.length === 0) {
        return <p className={cn(deviceGroupRowClassName, "text-13 text-morty-text-3")}>No other device has access.</p>;
    }
    return (
        <ul className="divide-y divide-border/40">
            {list.devices
                ?.toSorted((left, right) => Date.parse(right.joinedAt) - Date.parse(left.joinedAt))
                .map((device) => (
                    <li className={cn(deviceGroupRowClassName, "-mx-4 px-4")} key={device.id}>
                        {row(device)}
                    </li>
                ))}
        </ul>
    );
}

/**
 * Who can use this computer right now, and the way to take access away from any of them: one device, or all but
 * this browser and the computer. The computer always keeps access, so it can end everything shared from it.
 */
export function DevicesDialog({
    accessExpiry,
    computerName,
    devices,
    signal,
    store,
}: {
    readonly accessExpiry: StoreApi<AccessExpiryStore>;
    readonly computerName: string;
    /** The page's one list of the other devices with access. */
    readonly devices: StoreApi<LinkedDevicesStore>;
    readonly signal: () => AbortSignal;
    readonly store: StoreApi<DeviceAccessStore>;
}) {
    const { state, close, request, cancel, confirm } = useStore(store);
    const { state: list, refresh } = useStore(devices);
    if (state.kind === "closed") {
        return null;
    }
    const others: DisconnectTarget = { kind: "others" };
    const confirmingDevice =
        state.disconnection.kind !== "idle" && state.disconnection.target.kind === "device"
            ? state.disconnection.target
            : null;
    const row = (device: LinkedDevice) => {
        const description = describeLinkedDevice(device);
        const target: DisconnectTarget = { kind: "device", id: device.id, name: description.name };
        return (
            <DeviceSummary
                action={
                    <Tooltip.Provider delayDuration={150}>
                        <Tooltip.Root>
                            <Tooltip.Trigger asChild>
                                <Button
                                    aria-label={`Disconnect ${description.name}`}
                                    className="size-8 -my-1.5 -mr-2 text-morty-text-3"
                                    disabled={state.disconnection.kind === "disconnecting"}
                                    onClick={() => request(target)}
                                    size="icon"
                                    variant="ghost"
                                >
                                    <svg
                                        aria-hidden="true"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth="2"
                                        viewBox="0 0 24 24"
                                    >
                                        <path d="m7 11l-2 2a4.243 4.243 0 0 0 6 6l2-2m4-4l2-2a4.243 4.243 0 0 0-6-6l-2 2m5 12v2m3-5h2M8 5V3M5 8H3" />
                                    </svg>
                                </Button>
                            </Tooltip.Trigger>
                            <Tooltip.Portal>
                                <MortyTooltipContent side="top" sideOffset={6}>
                                    Disconnect
                                    <Tooltip.Arrow className="fill-foreground" />
                                </MortyTooltipContent>
                            </Tooltip.Portal>
                        </Tooltip.Root>
                    </Tooltip.Provider>
                }
                device={description}
            />
        );
    };
    return (
        <Dialog
            description="Who can use your computer from Morty, and for how long."
            onClose={close}
            title="Devices with access"
        >
            <div className={dialogBodyStackClassName}>
                {state.disconnected !== null && (
                    <p
                        className="rounded-[16px] border border-primary/20 bg-primary/5 px-3.5 py-3 text-13 leading-5 text-foreground"
                        role="status"
                    >
                        {state.disconnected.kind === "device"
                            ? `${state.disconnected.name} can no longer use your computer.`
                            : "Other devices can no longer use your computer, and links you shared that no one opened stop working."}
                    </p>
                )}

                <ul aria-label="Devices with access" className="space-y-5">
                    <li className="space-y-1.5">
                        <h3 className={dialogSectionTitleClassName}>Always here</h3>
                        <div className={deviceGroupCardClassName}>
                            <div className={deviceGroupRowClassName}>
                                <ThisBrowser accessExpiry={accessExpiry} />
                            </div>
                            <div className={cn(deviceGroupDividerClassName, deviceGroupRowClassName)}>
                                <DeviceSummary
                                    device={{
                                        name: computerName || "Your computer",
                                        details: [{ kind: "text", text: "Always keeps access · can disconnect all" }],
                                    }}
                                    icon={Laptop}
                                />
                            </div>
                        </div>
                    </li>
                    <li className="space-y-1.5">
                        <div className="flex items-center justify-between gap-3">
                            <h3 className={dialogSectionTitleClassName}>Shared from links</h3>
                            <LinkButton
                                className={cn("shrink-0", mutedTextLinkClassName)}
                                disabled={state.disconnection.kind === "disconnecting"}
                                onClick={() => request(others)}
                            >
                                Disconnect all
                            </LinkButton>
                        </div>
                        {confirmingDevice !== null ? (
                            <Dialog
                                busy={state.disconnection.kind === "disconnecting"}
                                description="It loses access right away. Your open windows reconnect in a few seconds."
                                footer={disconnectConfirmFooter(
                                    state.disconnection,
                                    cancel,
                                    () => void confirm(signal()),
                                )}
                                onClose={cancel}
                                title={`Disconnect ${confirmingDevice.name}?`}
                            >
                                {state.disconnection.kind === "failed" ? (
                                    <p className="text-destructive" role="alert">
                                        We couldn't confirm it was disconnected. Try again.
                                    </p>
                                ) : null}
                            </Dialog>
                        ) : null}
                        {targets(state.disconnection, others) ? (
                            <Dialog
                                busy={state.disconnection.kind === "disconnecting"}
                                description="They lose access right away, and links you shared that no one opened stop working. This browser and your computer keep access."
                                footer={disconnectConfirmFooter(
                                    state.disconnection,
                                    cancel,
                                    () => void confirm(signal()),
                                )}
                                onClose={cancel}
                                title="Disconnect every other device?"
                            >
                                {state.disconnection.kind === "failed" ? (
                                    <p className="text-destructive" role="alert">
                                        We couldn't confirm it was disconnected. Try again.
                                    </p>
                                ) : null}
                            </Dialog>
                        ) : null}
                        <div className={deviceGroupCardClassName}>
                            <OtherDevicesBody list={list} refresh={refresh} row={row} />
                        </div>
                    </li>
                </ul>

                <details className="disclosure-details group text-13 leading-5 text-morty-text-3">
                    <summary className="flex h-6 cursor-pointer list-none items-center gap-1.5 rounded-lg outline-none hover:text-morty-text-2 keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                        How access works
                        <ChevronDown
                            aria-hidden="true"
                            className="size-3.5 transition-[rotate] duration-300 ease-out group-open:rotate-180 motion-reduce:transition-none"
                        />
                    </summary>
                    <div className="mt-2 rounded-[16px] border border-border/60 bg-[#f2f3f5] px-3.5 py-3">
                        <ul className="list-disc space-y-1 pl-4 text-morty-text-2 marker:text-morty-text-4">
                            <li>Links work once, within 10 minutes.</li>
                            <li>You choose how long a device keeps access, from 1 hour to 30 days.</li>
                            <li>Disconnect any device here. Your computer always keeps access.</li>
                            <li>Morty records the approximate city a device joined from, never its IP address.</li>
                            <li>Your conversation history stays on your computer.</li>
                            <li>
                                Messages pass through Morty's relay and are not end-to-end encrypted.{" "}
                                <ExternalLink className={textLinkClassName} href={dataPolicy}>
                                    How Morty handles data
                                </ExternalLink>
                            </li>
                        </ul>
                    </div>
                </details>
            </div>
        </Dialog>
    );
}
