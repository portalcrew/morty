import type { StoreApi } from "zustand";
import { CopyLinkButton } from "../../components/chat/copy-link-button.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { dialogBodyStackClassName, dialogSectionTitleClassName } from "../../components/ui/dialog.tsx";
import { MortyAlert } from "../../components/ui/morty-alert.tsx";
import { Select } from "../../components/ui/option-select.tsx";
import { dataTestId } from "../../data-testid.ts";
import { cn } from "../../lib/utils.ts";
import {
    type DeviceAccessDuration,
    deviceAccessDurations,
    type IdentityTransfer,
} from "../../services/identity/anonymous-identity-api.ts";
import { formatMoment } from "../../view-models/chat/access-presentation.ts";
import {
    agentHandoffInstructions,
    type IdentitySharingStore,
    type SharingRecipient,
} from "../../view-models/chat/identity-sharing-store.ts";
import { useExternalStore } from "../../view-models/external-store.ts";

const durationLabels: Readonly<Record<DeviceAccessDuration, string>> = {
    "1h": "1 hour",
    "1d": "1 day",
    "7d": "7 days",
    "30d": "30 days",
};
const durationOptions = deviceAccessDurations.map((value) => ({ value, label: durationLabels[value] }));
const recipientOptions: readonly { readonly value: SharingRecipient; readonly label: string }[] = [
    { value: "person", label: "A person" },
    { value: "agent", label: "An AI agent" },
];

const shareMethodSubheadingClassName = "text-12 font-medium leading-4 text-morty-text-3";
const identitySharingSkeletonBarClassName = "rounded-full bg-morty-fill-opacity-3 motion-reduce:animate-none";
const identitySharingSkeletonPulseClassName = "animate-pulse motion-reduce:animate-none";
const identitySharingSkeletonFieldShellClassName = "rounded-lg border-[0.5px] border-black/5 bg-white";
const identitySharingSkeletonSelectClassName = "rounded-lg border border-border bg-background";
/** Matches a typical wrapped continue URL beside the QR code. */
const identitySharingUrlBoxClassName = "min-h-[4.5rem]";

function IdentitySharingDeviceAccessSkeleton() {
    return (
        <div
            aria-hidden="true"
            className={cn(
                "flex h-9 w-full items-center px-3",
                identitySharingSkeletonSelectClassName,
                identitySharingSkeletonPulseClassName,
            )}
        >
            <div className={cn("h-3.5 w-[4.75rem]", identitySharingSkeletonBarClassName)} />
        </div>
    );
}

function IdentitySharingTimingCopySkeleton() {
    return (
        <div aria-hidden="true" className={cn("space-y-2", identitySharingSkeletonPulseClassName)}>
            <div className={cn("h-3.5 w-full", identitySharingSkeletonBarClassName)} />
            <div className={cn("h-3.5 w-[68%]", identitySharingSkeletonBarClassName)} />
            <div className={cn("h-3.5 w-full sm:hidden", identitySharingSkeletonBarClassName)} />
            <div className={cn("h-3.5 w-[58%] sm:hidden", identitySharingSkeletonBarClassName)} />
        </div>
    );
}

const shareMethodGridClassName = "grid grid-cols-[auto_auto_minmax(0,1fr)] items-start gap-x-6 gap-y-2.5";
const shareMethodOrDividerClassName =
    "col-start-2 row-start-2 flex min-h-0 shrink-0 flex-col items-center self-stretch";
const shareMethodQrShellClassName =
    "col-start-1 row-start-2 shrink-0 rounded-lg border-[0.5px] border-black/5 bg-white p-3";

type IdentitySharingTransferSectionProps =
    | { readonly loading: true }
    | {
          readonly loading: false;
          readonly image: string;
          readonly transfer: IdentityTransfer;
          readonly replacedEarlier: boolean;
      };

function IdentitySharingTransferSection(props: IdentitySharingTransferSectionProps) {
    const loading = props.loading;
    return (
        <div
            className="space-y-4"
            {...(loading ? { role: "status" as const } : { "data-testid": dataTestId.identitySharing })}
        >
            {loading ? <span className="sr-only">Preparing sharing details…</span> : null}
            <div className="space-y-2.5">
                <h3 className={dialogSectionTitleClassName}>Sharing method</h3>
                <div className={shareMethodGridClassName}>
                    <p className={`col-start-1 row-start-1 ${shareMethodSubheadingClassName}`}>QR code sharing</p>
                    <p className={`col-start-3 row-start-1 ${shareMethodSubheadingClassName}`}>Link sharing</p>
                    <div className={shareMethodQrShellClassName}>
                        {loading ? (
                            <div
                                aria-hidden="true"
                                className={cn(
                                    "size-40 shrink-0 rounded-sm bg-morty-fill-opacity-3",
                                    identitySharingSkeletonPulseClassName,
                                )}
                            />
                        ) : (
                            <img
                                className="size-40 shrink-0"
                                src={props.image}
                                alt="Continue on another device QR code"
                            />
                        )}
                    </div>
                    <div aria-hidden="true" className={shareMethodOrDividerClassName}>
                        <div className="min-h-0 w-[0.5px] flex-1 bg-border/60" />
                        <p className="py-2 text-11 font-medium uppercase tracking-wide text-morty-text-4">or</p>
                        <div className="min-h-0 w-[0.5px] flex-1 bg-border/60" />
                    </div>
                    {loading ? (
                        <div
                            aria-hidden="true"
                            className={cn(
                                "col-start-3 row-start-2 min-w-0 space-y-3",
                                identitySharingSkeletonPulseClassName,
                            )}
                        >
                            <div
                                className={cn(
                                    "flex flex-col justify-center gap-2 px-4 py-3",
                                    identitySharingSkeletonFieldShellClassName,
                                    identitySharingUrlBoxClassName,
                                )}
                            >
                                <div className={cn("h-3.5 w-full", identitySharingSkeletonBarClassName)} />
                                <div className={cn("h-3.5 w-11/12", identitySharingSkeletonBarClassName)} />
                                <div className={cn("h-3.5 w-[70%]", identitySharingSkeletonBarClassName)} />
                            </div>
                            <div className="h-9 w-28 rounded-lg bg-morty-fill-opacity-3" />
                        </div>
                    ) : (
                        <CopyLinkButton
                            className="col-start-3 row-start-2 min-w-0"
                            prominent
                            url={props.transfer.url}
                            urlClassName={identitySharingUrlBoxClassName}
                        />
                    )}
                </div>
            </div>
            {loading ? (
                <IdentitySharingTimingCopySkeleton />
            ) : (
                <IdentitySharingTiming replacedEarlier={props.replacedEarlier} transfer={props.transfer} />
            )}
        </div>
    );
}

function IdentitySharingTiming({
    transfer,
    replacedEarlier,
}: {
    readonly transfer: IdentityTransfer;
    readonly replacedEarlier: boolean;
}) {
    return (
        <p className="text-xs leading-5 text-morty-text-3">
            Works for one device until {formatMoment(transfer.expiresAt)}. That device keeps access until{" "}
            {formatMoment(transfer.accessExpiresAt)}.
            {transfer.accessLimitedBySharer &&
                " This browser's own access ends then, so the device cannot keep it longer."}
            {replacedEarlier && " The previous link no longer works."}
        </p>
    );
}

function AgentHandoffHeading() {
    return (
        <div className="space-y-0.5">
            <h3 className={dialogSectionTitleClassName}>Instructions for the agent</h3>
            <p className="text-xs leading-5 text-morty-text-3">
                Paste these instructions into your AI agent&apos;s chat to connect it to this computer.
            </p>
        </div>
    );
}

function AgentHandoffSection({
    transfer,
    replacedEarlier,
}: {
    readonly transfer: IdentityTransfer;
    readonly replacedEarlier: boolean;
}) {
    return (
        <div className="space-y-4" data-testid={dataTestId.agentHandoff}>
            <div className="space-y-2.5">
                <AgentHandoffHeading />
                <CopyLinkButton
                    copyLabel="Copy instructions"
                    prominent
                    subject="instructions"
                    url={agentHandoffInstructions(transfer)}
                    urlClassName="whitespace-pre-wrap break-normal"
                />
            </div>
            <IdentitySharingTiming replacedEarlier={replacedEarlier} transfer={transfer} />
        </div>
    );
}

function AgentHandoffSkeleton() {
    return (
        <div className="space-y-4" role="status">
            <span className="sr-only">Preparing agent instructions…</span>
            <div className="space-y-2.5">
                <AgentHandoffHeading />
                <div
                    aria-hidden="true"
                    className={cn(
                        "min-h-40 space-y-2 px-4 py-3",
                        identitySharingSkeletonFieldShellClassName,
                        identitySharingSkeletonPulseClassName,
                    )}
                >
                    <div className={cn("h-3.5 w-[85%]", identitySharingSkeletonBarClassName)} />
                    <div className={cn("h-3.5 w-full", identitySharingSkeletonBarClassName)} />
                    <div className={cn("h-3.5 w-[92%]", identitySharingSkeletonBarClassName)} />
                    <div className={cn("h-3.5 w-[76%]", identitySharingSkeletonBarClassName)} />
                    <div className={cn("h-3.5 w-full", identitySharingSkeletonBarClassName)} />
                    <div className={cn("h-3.5 w-[58%]", identitySharingSkeletonBarClassName)} />
                </div>
                <div
                    aria-hidden="true"
                    className={cn("h-9 w-40 rounded-lg bg-morty-fill-opacity-3", identitySharingSkeletonPulseClassName)}
                />
            </div>
            <IdentitySharingTimingCopySkeleton />
        </div>
    );
}

/** Renders the sharing dialog's transfer, whose store is created when the dialog opens. */
export function IdentitySharing({ store }: { readonly store: StoreApi<IdentitySharingStore> }) {
    const state = useExternalStore(store, (state) => state.state);
    const choose = useExternalStore(store, (state) => state.choose);
    const recipient = useExternalStore(store, (state) => state.recipient);
    const chooseRecipient = useExternalStore(store, (state) => state.chooseRecipient);
    const recipientTransitioning = useExternalStore(store, (state) => state.recipientTransitioning);
    // The Worker states the duration a link grants; until the first link exists there is nothing to show.
    const duration =
        state.kind === "ready" ? state.transfer.accessDuration : state.kind === "initial" ? null : state.duration;
    const loading = state.kind === "initial" || state.kind === "loading";
    const showDeviceAccess = duration !== null || loading;
    return (
        <div className={dialogBodyStackClassName}>
            <MortyAlert tone="warning">
                Anyone who opens this link can view and control every session on this computer.
            </MortyAlert>
            <div className="grid gap-2">
                <p className={dialogSectionTitleClassName}>Share with</p>
                <Select
                    label="Share with"
                    onValueChange={(value) => {
                        const chosen = recipientOptions.find((option) => option.value === value);
                        if (chosen !== undefined) {
                            chooseRecipient(chosen.value);
                        }
                    }}
                    options={recipientOptions}
                    value={recipient}
                    viewportClassName="pt-2.5"
                />
            </div>
            {showDeviceAccess && (
                <div className="grid gap-2">
                    <p className={dialogSectionTitleClassName}>Device access</p>
                    {duration === null ? (
                        <IdentitySharingDeviceAccessSkeleton />
                    ) : (
                        <Select
                            disabled={state.kind === "refused"}
                            label="Device access"
                            onValueChange={(value) => {
                                const chosen = deviceAccessDurations.find((option) => option === value);
                                if (chosen !== undefined) {
                                    choose(chosen);
                                }
                            }}
                            options={durationOptions}
                            value={duration}
                            viewportClassName="pt-2.5"
                        />
                    )}
                </div>
            )}
            {state.kind === "unconfirmed" && (
                <div className="space-y-2">
                    <p role="alert">Could not confirm the sharing link. Retry to recover it safely.</p>
                    <Button onClick={store.getState().retry}>Retry sharing link</Button>
                </div>
            )}
            {state.kind === "refused" && (
                <p role="alert">
                    The previous link or your access is no longer available. Close this dialog and share again.
                </p>
            )}
            {loading || (state.kind === "ready" && recipientTransitioning) ? (
                recipient === "agent" ? (
                    <AgentHandoffSkeleton />
                ) : (
                    <IdentitySharingTransferSection loading />
                )
            ) : state.kind === "ready" && recipient === "agent" ? (
                <AgentHandoffSection replacedEarlier={state.replacedEarlier} transfer={state.transfer} />
            ) : state.kind === "ready" ? (
                <IdentitySharingTransferSection
                    image={state.image}
                    loading={false}
                    replacedEarlier={state.replacedEarlier}
                    transfer={state.transfer}
                />
            ) : null}
        </div>
    );
}
