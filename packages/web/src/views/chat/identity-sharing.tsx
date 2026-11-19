import { Download } from "lucide-react";
import { type StoreApi, useStore } from "zustand";
import { CopyLinkButton } from "../../components/chat/copy-link-button.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { dialogBodyStackClassName, dialogSectionTitleClassName } from "../../components/ui/dialog.tsx";
import { MortyAlert } from "../../components/ui/morty-alert.tsx";
import { Select } from "../../components/ui/option-select.tsx";
import { dataTestId } from "../../data-testid.ts";
import { cn } from "../../lib/utils.ts";
import type { IdentityTransfer } from "../../services/identity/anonymous-identity-api.ts";
import { formatMoment } from "../../view-models/chat/access-presentation.ts";
import {
    agentHandoffInstructions,
    chosenDuration,
    durationChoices,
    type IdentitySharingStore,
    type SharingRecipient,
} from "../../view-models/chat/identity-sharing-store.ts";

const recipientOptions: readonly { readonly value: SharingRecipient; readonly label: string }[] = [
    { value: "person", label: "A person" },
    { value: "agent", label: "An AI agent" },
];

const shareMethodSubheadingClassName = "text-12 font-medium leading-4 text-morty-text-3";
const identitySharingSkeletonBarClassName = "rounded-full bg-morty-fill-opacity-3 motion-reduce:animate-none";
const identitySharingSkeletonPulseClassName = "animate-pulse motion-reduce:animate-none";
const identitySharingSkeletonFieldShellClassName = "rounded-lg border-[0.5px] border-black/5 bg-white";
const identitySharingSkeletonSelectClassName = "rounded-lg border border-border bg-background";
const identitySharingUrlBoxClassName = "h-32";

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

const shareMethodGridClassName =
    "grid min-w-0 grid-cols-1 items-start gap-y-2.5 sm:grid-cols-[auto_auto_minmax(0,1fr)] sm:gap-x-6";
const shareMethodOrDividerClassName =
    "col-start-1 row-start-3 flex items-center gap-3 sm:col-start-2 sm:row-start-2 sm:min-h-0 sm:shrink-0 sm:flex-col sm:gap-0 sm:self-stretch";
const shareMethodQrSectionClassName = "col-start-1 row-start-2 flex min-w-0 flex-wrap items-center gap-3";
const shareMethodQrCardClassName = "rounded-lg border-[0.5px] border-black/5 bg-white p-3";

type IdentitySharingTransferSectionProps =
    | { readonly loading: true; readonly allowQrDownload: boolean }
    | {
          readonly loading: false;
          readonly allowQrDownload: boolean;
          readonly image: string;
          readonly transfer: IdentityTransfer;
          readonly replacedEarlier: boolean;
          readonly sharerLimitShown: boolean;
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
                    <p
                        className={`col-start-1 row-start-4 sm:col-start-3 sm:row-start-1 ${shareMethodSubheadingClassName}`}
                    >
                        Link sharing
                    </p>
                    <div
                        className={cn(
                            shareMethodQrSectionClassName,
                            props.allowQrDownload && shareMethodQrCardClassName,
                        )}
                    >
                        <div className={cn("w-fit shrink-0", !props.allowQrDownload && shareMethodQrCardClassName)}>
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
                        {props.allowQrDownload && (
                            <div className="@container/qr-actions flex min-w-9 flex-1 flex-col items-start gap-2">
                                <p className="text-14 leading-5 text-morty-text-3">
                                    Long press the QR code or tap the button to save it.
                                </p>
                                {loading ? (
                                    <div
                                        aria-hidden="true"
                                        className={cn(
                                            "size-9 rounded-full bg-morty-fill-opacity-3 @min-[150px]/qr-actions:w-36 @min-[150px]/qr-actions:rounded-lg",
                                            identitySharingSkeletonPulseClassName,
                                        )}
                                    />
                                ) : (
                                    <Button
                                        asChild
                                        variant="primary"
                                        size="icon"
                                        className="@min-[150px]/qr-actions:w-auto @min-[150px]/qr-actions:gap-1.5 @min-[150px]/qr-actions:px-4 @min-[150px]/qr-actions:[font-size:13px]"
                                    >
                                        <a aria-label="Save QR code" download="morty-access-qr.png" href={props.image}>
                                            <Download aria-hidden="true" />
                                            <span className="hidden @min-[150px]/qr-actions:inline">Save QR code</span>
                                        </a>
                                    </Button>
                                )}
                            </div>
                        )}
                    </div>
                    <div aria-hidden="true" className={shareMethodOrDividerClassName}>
                        <div className="h-[0.5px] min-w-0 flex-1 bg-border/60 sm:h-auto sm:min-h-0 sm:w-[0.5px]" />
                        <p className="py-2 text-11 font-medium uppercase tracking-wide text-morty-text-4">or</p>
                        <div className="h-[0.5px] min-w-0 flex-1 bg-border/60 sm:h-auto sm:min-h-0 sm:w-[0.5px]" />
                    </div>
                    {loading ? (
                        <div
                            aria-hidden="true"
                            className={cn(
                                "col-start-1 row-start-5 min-w-0 space-y-3 sm:col-start-3 sm:row-start-2",
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
                            className="col-start-1 row-start-5 min-w-0 sm:col-start-3 sm:row-start-2"
                            scrollableUrl
                            url={props.transfer.url}
                            urlClassName={identitySharingUrlBoxClassName}
                        />
                    )}
                </div>
            </div>
            {loading ? (
                <IdentitySharingTimingCopySkeleton />
            ) : (
                <IdentitySharingTiming
                    replacedEarlier={props.replacedEarlier}
                    sharerLimitShown={props.sharerLimitShown}
                    transfer={props.transfer}
                />
            )}
        </div>
    );
}

function IdentitySharingTiming({
    transfer,
    replacedEarlier,
    sharerLimitShown,
}: {
    readonly transfer: IdentityTransfer;
    readonly replacedEarlier: boolean;
    readonly sharerLimitShown: boolean;
}) {
    return (
        <p className="text-xs leading-5 text-morty-text-3">
            Works for one device until {formatMoment(transfer.expiresAt)}. That device keeps access until{" "}
            {formatMoment(transfer.accessExpiresAt)}.
            {transfer.accessLimitedBySharer &&
                !sharerLimitShown &&
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
    sharerLimitShown,
}: {
    readonly transfer: IdentityTransfer;
    readonly replacedEarlier: boolean;
    readonly sharerLimitShown: boolean;
}) {
    return (
        <div className="space-y-4" data-testid={dataTestId.agentHandoff}>
            <div className="space-y-2.5">
                <AgentHandoffHeading />
                <CopyLinkButton
                    copyLabel="Copy instructions"
                    scrollableUrl
                    subject="instructions"
                    url={agentHandoffInstructions(transfer)}
                    urlClassName="max-h-32"
                />
            </div>
            <IdentitySharingTiming
                replacedEarlier={replacedEarlier}
                sharerLimitShown={sharerLimitShown}
                transfer={transfer}
            />
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
                        "h-32 space-y-2 overflow-hidden px-4 py-3",
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

export function IdentitySharing({
    store,
    allowQrDownload = false,
}: {
    readonly store: StoreApi<IdentitySharingStore>;
    readonly allowQrDownload?: boolean;
}) {
    const state = useStore(store, (state) => state.state);
    const choose = useStore(store, (state) => state.choose);
    const recipient = useStore(store, (state) => state.recipient);
    const chooseRecipient = useStore(store, (state) => state.chooseRecipient);
    const recipientTransitioning = useStore(store, (state) => state.recipientTransitioning);
    const durationOptions = useStore(store, (state) => state.durationOptions);
    const choices = durationChoices(state, durationOptions);
    const loading = state.kind === "initial" || state.kind === "loading";
    const showDeviceAccess = choices.selected !== null || loading;
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
                    {choices.selected === null ? (
                        <IdentitySharingDeviceAccessSkeleton />
                    ) : (
                        <Select
                            description={
                                choices.sharerAccessEndsAt === null
                                    ? undefined
                                    : `This browser's access ends ${formatMoment(choices.sharerAccessEndsAt)}, so a device you share with can't keep access longer.`
                            }
                            disabled={state.kind === "refused"}
                            label="Device access"
                            onValueChange={(value) => {
                                const chosen = choices.options.find((option) => option.value === value);
                                const duration =
                                    chosen === undefined ? null : chosenDuration(chosen.value, durationOptions);
                                if (duration !== null) {
                                    choose(duration);
                                }
                            }}
                            options={choices.options}
                            value={choices.selected}
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
                    <IdentitySharingTransferSection allowQrDownload={allowQrDownload} loading />
                )
            ) : state.kind === "ready" && recipient === "agent" ? (
                <AgentHandoffSection
                    replacedEarlier={state.replacedEarlier}
                    sharerLimitShown={choices.sharerAccessEndsAt !== null}
                    transfer={state.transfer}
                />
            ) : state.kind === "ready" ? (
                <IdentitySharingTransferSection
                    allowQrDownload={allowQrDownload}
                    image={state.image}
                    loading={false}
                    replacedEarlier={state.replacedEarlier}
                    sharerLimitShown={choices.sharerAccessEndsAt !== null}
                    transfer={state.transfer}
                />
            ) : null}
        </div>
    );
}
