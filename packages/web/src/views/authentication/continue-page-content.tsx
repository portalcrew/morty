import { Check, Copy } from "lucide-react";
import type { ReactNode } from "react";
import { SetupPromptCopiedHint, SetupPromptIdleHint } from "../../components/setup/setup-prompt-guidance.tsx";
import { ButtonGroup } from "../../components/ui/button-group.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { CopyToClipboardButton } from "../../components/ui/copy-to-clipboard-button.tsx";
import { agentSetupPrompt } from "../../services/device/setup-handoff.ts";
import type { ContinueState } from "../../view-models/authentication/continue-store.ts";
import { describePageFailure } from "../../view-models/format-error.ts";
import { GlobalLoadingPage } from "../setup/global-loading-page.tsx";
import {
    SetupCardDescription,
    SetupCardFailureIcon,
    SetupCardShell,
    SetupCardTitle,
    setupPrimaryButtonClassName,
    setupPrimaryButtonSize,
} from "../setup/setup-card-shell.tsx";

function ContinueError({
    title,
    content,
    children,
}: {
    readonly title: string;
    readonly content: ReactNode;
    readonly children?: ReactNode;
}) {
    return (
        <SetupCardShell cardClassName="pb-10" cardLeading={<SetupCardFailureIcon />} titleId="continue-title">
            <div className="w-full" role="alert">
                <SetupCardTitle id="continue-title">{title}</SetupCardTitle>
                <SetupCardDescription>{content}</SetupCardDescription>
            </div>
            {children}
        </SetupCardShell>
    );
}

export function ContinuePageContent({
    enterMorty,
    continueHref = null,
    retry,
    state,
}: {
    readonly enterMorty: () => void;
    readonly continueHref?: string | null;
    readonly retry: () => void;
    readonly state: ContinueState;
}) {
    const fallback =
        continueHref === null ? null : (
            <Button
                asChild
                className={`${setupPrimaryButtonClassName} text-center`}
                size={setupPrimaryButtonSize}
                variant="outline"
            >
                <a href={continueHref}>Back to your last computer</a>
            </Button>
        );
    switch (state.kind) {
        case "handoff-unsealing":
        case "session-opening":
        case "session-resuming":
            return <GlobalLoadingPage label="Opening session" />;
        case "session-failed": {
            const copy = describePageFailure(state.message, "Couldn't open this session");
            return (
                <ContinueError title={copy.title} content={copy.content}>
                    <ButtonGroup className="mt-6 w-full" size={setupPrimaryButtonSize}>
                        <Button className={setupPrimaryButtonClassName} onClick={retry} size={setupPrimaryButtonSize}>
                            Try again
                        </Button>
                        <Button
                            className={setupPrimaryButtonClassName}
                            onClick={enterMorty}
                            size={setupPrimaryButtonSize}
                            variant="outline"
                        >
                            Go to Morty
                        </Button>
                    </ButtonGroup>
                </ContinueError>
            );
        }
        case "handoff-failed":
        case "redeem-failed": {
            const copy = describePageFailure(state.message, "Couldn't continue");
            return (
                <ContinueError title={copy.title} content={copy.content}>
                    <ButtonGroup className="mt-6 w-full" size={setupPrimaryButtonSize}>
                        <Button className={setupPrimaryButtonClassName} onClick={retry} size={setupPrimaryButtonSize}>
                            Try again
                        </Button>
                        {fallback}
                    </ButtonGroup>
                </ContinueError>
            );
        }
        case "link-unavailable": {
            const setupPrompt = state.recovery === "setup" ? agentSetupPrompt() : null;
            return (
                <ContinueError
                    title="This link is no longer available"
                    content={
                        state.recovery === "setup"
                            ? `${state.message} Run setup again on that computer.`
                            : `${state.message} Ask for a new link.`
                    }
                >
                    {setupPrompt !== null ? (
                        <div className="mt-5 w-full">
                            <CopyToClipboardButton
                                className={setupPrimaryButtonClassName}
                                copiedContent={
                                    <>
                                        <Check aria-hidden="true" className="size-4" />
                                        Copied
                                    </>
                                }
                                failureToast={{
                                    description: "Your browser blocked the copy. Try again.",
                                    title: "Could not copy",
                                }}
                                idleContent={<SetupPromptIdleHint />}
                                label="Copy setup prompt"
                                size={setupPrimaryButtonSize}
                                successContent={<SetupPromptCopiedHint />}
                                value={setupPrompt}
                            >
                                <Copy aria-hidden="true" className="size-4" />
                                <span>Copy setup prompt</span>
                            </CopyToClipboardButton>
                            {fallback !== null && <div className="mt-3">{fallback}</div>}
                        </div>
                    ) : (
                        fallback !== null && (
                            <ButtonGroup className="mt-5 w-full" size={setupPrimaryButtonSize}>
                                {fallback}
                            </ButtonGroup>
                        )
                    )}
                </ContinueError>
            );
        }
        case "identity-redeeming":
            return <GlobalLoadingPage label="Securely transferring Morty access" />;
        case "failed": {
            const copy = describePageFailure(state.message, "Couldn't continue");
            return (
                <ContinueError title={copy.title} content={copy.content}>
                    <ButtonGroup className="mt-6 w-full" size={setupPrimaryButtonSize}>
                        <Button className={setupPrimaryButtonClassName} onClick={retry} size={setupPrimaryButtonSize}>
                            Try again
                        </Button>
                        {fallback}
                    </ButtonGroup>
                </ContinueError>
            );
        }
        case "invalid":
            return (
                <ContinueError title="This transfer link is invalid" content="Ask for a new link.">
                    {fallback !== null && (
                        <ButtonGroup className="mt-5 w-full" size={setupPrimaryButtonSize}>
                            {fallback}
                        </ButtonGroup>
                    )}
                </ContinueError>
            );
    }
}
