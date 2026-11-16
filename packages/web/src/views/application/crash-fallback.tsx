import { Button } from "../../components/ui/cloud-button.tsx";
import type { BugReportDialogStore } from "../../view-models/bug-report-dialog-store.ts";
import { BugReportButton, BugReportDialogHost } from "../diagnostics/bug-report-button.tsx";
import {
    SetupCardDescription,
    SetupCardFailureIcon,
    SetupCardSection,
    SetupCardShell,
    SetupCardTitle,
    setupPrimaryButtonClassName,
    setupPrimaryButtonSize,
} from "../setup/setup-card-shell.tsx";

export function MortyCrashFallback({ dialog }: { readonly dialog: BugReportDialogStore }) {
    return (
        <>
            <SetupCardShell cardClassName="pb-10" cardLeading={<SetupCardFailureIcon />} titleId="crash-title">
                <div role="alert">
                    <SetupCardTitle id="crash-title">Morty encountered an error</SetupCardTitle>
                    <SetupCardDescription>Please reload to try again.</SetupCardDescription>
                </div>
                <SetupCardSection className="mt-4">
                    <Button
                        className={setupPrimaryButtonClassName}
                        onClick={() => {
                            window.location.reload();
                        }}
                        size={setupPrimaryButtonSize}
                    >
                        Try again
                    </Button>
                </SetupCardSection>
            </SetupCardShell>
            <BugReportButton appearance="floating" dialog={dialog} />
            <BugReportDialogHost dialog={dialog} />
        </>
    );
}
