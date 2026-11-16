import { type AnyRouter, RouterProvider } from "@tanstack/react-router";
import { ArrowLeft, ArrowUpRight, Unplug } from "lucide-react";
import { SetupConnectionGraphic } from "../../components/setup/setup-connection-graphic.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { ExternalLink } from "../../components/ui/external-link.tsx";
import { MortyAlert } from "../../components/ui/morty-alert.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import type { BugReportDialogStore } from "../../view-models/bug-report-dialog-store.ts";
import type { SetupHandoffModel } from "../../view-models/send-link-store.ts";
import { PairingInstruction } from "../chat/pairing-instruction.tsx";
import { BugReportButton, BugReportDialogHost } from "../diagnostics/bug-report-button.tsx";
import { mortyRepository } from "../morty-repository.ts";
import { GlobalLoadingPage } from "../setup/global-loading-page.tsx";
import {
    SetupCardAlert,
    SetupCardDescription,
    SetupCardFailureIcon,
    SetupCardSection,
    SetupCardShell,
    SetupCardTitle,
    setupPrimaryButtonClassName,
    setupPrimaryButtonSize,
} from "../setup/setup-card-shell.tsx";

export type AppState =
    | { readonly kind: "loading" }
    | { readonly kind: "failed"; readonly retry: () => void; readonly retrying: boolean }
    | { readonly kind: "invalid-link"; readonly continueHref: string | null }
    | { readonly kind: "unpaired" }
    | {
          readonly kind: "setup";
          readonly notice: "access-ended" | "none";
          readonly returnHref: string | null;
          readonly setupHandoff: SetupHandoffModel;
      }
    | { readonly kind: "authentication"; readonly router: AnyRouter }
    | {
          readonly kind: "signed-in";
          readonly router: AnyRouter;
      };

export function App({
    bugReportDialog,
    state,
}: {
    readonly bugReportDialog: BugReportDialogStore;
    readonly state: AppState;
}) {
    // This component owns the dialog's single host for the application's
    // whole interactive life: it renders in every state, so the host survives
    // the loading → ready transition without remounting or cancelling an
    // in-flight send. The crash fallback mounts its own host only after this
    // tree has unmounted, so exactly one host exists at any time.
    return (
        <>
            <ApplicationContent state={state} />
            {(state.kind === "loading" || state.kind === "failed") && (
                <BugReportButton appearance="floating" dialog={bugReportDialog} />
            )}
            <BugReportDialogHost dialog={bugReportDialog} />
        </>
    );
}

function ApplicationContent({ state }: { readonly state: AppState }) {
    switch (state.kind) {
        case "loading":
            return <GlobalLoadingPage label="Loading Morty" />;
        case "failed":
            return (
                <SetupCardShell cardClassName="pb-10" cardLeading={<SetupCardFailureIcon />} titleId="bootstrap-failed">
                    <SetupCardTitle id="bootstrap-failed">Morty is unavailable</SetupCardTitle>
                    <SetupCardDescription>
                        Check your connection and try again. Your saved computers are still here.
                    </SetupCardDescription>
                    <SetupCardSection className="mt-4">
                        <Button
                            aria-busy={state.retrying}
                            className={setupPrimaryButtonClassName}
                            disabled={state.retrying}
                            onClick={state.retry}
                            size={setupPrimaryButtonSize}
                        >
                            {state.retrying ? (
                                <>
                                    <Spinner className="text-background" label="Retrying" />
                                    Retrying…
                                </>
                            ) : (
                                "Retry"
                            )}
                        </Button>
                    </SetupCardSection>
                </SetupCardShell>
            );
        case "unpaired":
            return (
                <SetupCardShell cardLeading={<SetupCardFailureIcon />} titleId="unpaired-title">
                    <SetupCardTitle id="unpaired-title">Browser not paired</SetupCardTitle>
                    <SetupCardDescription>Copied browser URLs don’t grant access.</SetupCardDescription>
                    <SetupCardDescription>Open your agent’s link or scan its QR code.</SetupCardDescription>
                    <SetupCardSection className="mt-4">
                        <Button asChild className={setupPrimaryButtonClassName} size={setupPrimaryButtonSize}>
                            <a href="/">Go to morty</a>
                        </Button>
                    </SetupCardSection>
                </SetupCardShell>
            );
        case "invalid-link":
            return (
                <SetupCardShell cardLeading={<SetupCardFailureIcon />} titleId="invalid-link-title">
                    <SetupCardTitle id="invalid-link-title">This link is no longer valid</SetupCardTitle>
                    <SetupCardAlert>Ask for a new link. Morty has not switched to another computer.</SetupCardAlert>
                    {state.continueHref !== null && (
                        <Button
                            asChild
                            className={`${setupPrimaryButtonClassName} mt-5 text-center`}
                            size={setupPrimaryButtonSize}
                            variant="outline"
                        >
                            <a href={state.continueHref}>Back to your last computer</a>
                        </Button>
                    )}
                </SetupCardShell>
            );
        case "setup":
            return (
                <SetupApplication
                    notice={state.notice}
                    returnHref={state.returnHref}
                    setupHandoff={state.setupHandoff}
                />
            );
        case "authentication":
            return <RouterProvider router={state.router} />;
        case "signed-in":
            return <RouterProvider router={state.router} />;
    }
}

/** Where a visitor verifies what Morty does before running setup. */
const mortyResources = [
    ["How Morty handles data", `${mortyRepository}#what-morty-does-with-your-data`],
    ["Security", `${mortyRepository}/blob/main/SECURITY.md`],
    ["Report an issue", `${mortyRepository}/issues/new`],
] as const;

function SetupApplication({
    notice,
    returnHref,
    setupHandoff,
}: {
    readonly notice: "access-ended" | "none";
    readonly returnHref: string | null;
    readonly setupHandoff: SetupHandoffModel;
}) {
    const pageNotice =
        notice === "access-ended" ? (
            <MortyAlert
                className="w-full items-start justify-center rounded-[12px] border-primary/25 bg-primary/10 px-6 py-3 text-center text-foreground shadow-none [&>div]:flex-initial [&>svg]:mt-[3px] [&>svg]:text-primary"
                icon={Unplug}
                tone="info"
            >
                <p>
                    <span className="font-medium">Current access ended</span>{" "}
                    <span className="text-muted-foreground">
                        Your local agent and tasks keep running. To continue here, open a new link from your computer or
                        another device.
                    </span>
                </p>
            </MortyAlert>
        ) : undefined;

    const pageAction =
        returnHref === null ? undefined : (
            <Button asChild size="sm" variant="ghost">
                <a href={returnHref}>
                    <ArrowLeft aria-hidden="true" className="size-4" />
                    <span>Back to your last computer</span>
                </a>
            </Button>
        );

    return (
        <SetupCardShell
            headerAction={
                <Button
                    onClick={() => {
                        window.open(mortyRepository, "_blank", "noopener,noreferrer");
                    }}
                    size="sm"
                    variant="ghost"
                >
                    GitHub
                    <ArrowUpRight aria-hidden="true" />
                    <span className="sr-only">(opens in a new tab)</span>
                </Button>
            }
            pageAction={pageAction}
            pageFooter={
                <footer className="shrink-0 px-6 pb-6">
                    <nav aria-label="About Morty">
                        <ul className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs leading-5">
                            {mortyResources.map(([label, href]) => (
                                <li key={label}>
                                    <ExternalLink className="text-morty-text-3 hover:text-morty-text-2" href={href}>
                                        {label}
                                    </ExternalLink>
                                </li>
                            ))}
                        </ul>
                    </nav>
                </footer>
            }
            pageNotice={pageNotice}
            titleId="setup-title"
        >
            <SetupConnectionGraphic />
            <SetupCardTitle className="text-balance" id="setup-title">
                {returnHref === null ? "Step away. Keep your agent working." : "Connect another computer"}
            </SetupCardTitle>
            <SetupCardDescription className="text-pretty">
                {returnHref === null
                    ? "Check in and reply from any browser. Your agent keeps running on your computer."
                    : "Run one setup prompt on the computer you want to add."}
            </SetupCardDescription>
            <div className="mt-4 w-full">
                <PairingInstruction handoff={setupHandoff} />
            </div>
            {returnHref === null && (
                <p className="mt-5 text-center text-xs leading-5 text-morty-text-2">
                    History stays on your computer · End-to-end encrypted ·{" "}
                    <ExternalLink className="underline underline-offset-2 hover:text-foreground" href={mortyRepository}>
                        Open source
                    </ExternalLink>
                </p>
            )}
        </SetupCardShell>
    );
}
