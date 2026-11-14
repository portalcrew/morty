import { Check, Copy, Link, Send } from "lucide-react";
import { useStore } from "zustand";
import {
    SetupPromptCopiedHint,
    SetupPromptDetails,
    SetupPromptIdleHint,
} from "../../components/setup/setup-prompt-guidance.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { CopyToClipboardButton } from "../../components/ui/copy-to-clipboard-button.tsx";
import { agentSetupPrompt } from "../../services/device/setup-handoff.ts";
import type { SendLinkStoreApi, SetupHandoffModel } from "../../view-models/send-link-store.ts";
import { setupPrimaryButtonClassName, setupPrimaryButtonSize } from "../setup/setup-card-shell.tsx";

const copyPrompt: SetupHandoffModel = { kind: "copy-prompt" };
const handoffHint = "Setup runs on your computer. Open Morty there to copy the prompt.";
const handoffHintClassName = "mt-3 min-h-10 text-center text-sm leading-5 text-morty-text-2";
const unavailableLink = { description: "Copy this page's address from your browser instead.", title: "Could not send" };

function mortyAddress(): string {
    return `${window.location.origin}/`;
}

type PairingActionPresentation = "setup-card" | "dialog";

function pairingPrimaryActionProps(presentation: PairingActionPresentation): {
    readonly className: string;
    readonly size: "default" | "lg";
} {
    if (presentation === "dialog") {
        return { className: "w-full", size: "default" };
    }
    return { className: setupPrimaryButtonClassName, size: setupPrimaryButtonSize };
}

/** A phone or tablet cannot run setup, so it sends Morty's address to the computer through the share sheet. */
function ShareSetupLink({
    hintClassName,
    primaryAction,
    sendLink,
}: {
    readonly hintClassName: string;
    readonly primaryAction: ReturnType<typeof pairingPrimaryActionProps>;
    readonly sendLink: SendLinkStoreApi;
}) {
    const { send, state } = useStore(sendLink);
    return (
        <>
            <Button
                aria-busy={state.kind === "sending"}
                className={primaryAction.className}
                disabled={state.kind === "sending"}
                onClick={() =>
                    send({
                        text: "Set up Morty on the computer where your agent runs.",
                        title: "Morty",
                        url: mortyAddress(),
                    })
                }
                size={primaryAction.size}
            >
                <Send aria-hidden="true" className="size-4" />
                <span>Send to my computer</span>
            </Button>
            {state.kind === "failed" ? (
                <p className={hintClassName} role="status">
                    Could not open sharing. Copy this page's address from your browser instead.
                </p>
            ) : (
                <p className={hintClassName}>{handoffHint}</p>
            )}
        </>
    );
}

export function PairingInstruction({
    actionPresentation = "setup-card",
    handoff = copyPrompt,
}: {
    /** Setup cards use full-width rounded actions; dialogs use standard cloud buttons. */
    readonly actionPresentation?: PairingActionPresentation;
    /** How this device moves setup to the agent's computer; copying the prompt unless the caller knows better. */
    readonly handoff?: SetupHandoffModel;
}) {
    const setupInstruction = agentSetupPrompt();
    const primaryAction = pairingPrimaryActionProps(actionPresentation);
    const hintClassName =
        actionPresentation === "dialog"
            ? "mt-3 min-h-10 text-center text-13 leading-5 text-muted-foreground"
            : handoffHintClassName;
    return (
        <div>
            {handoff.kind === "share" ? (
                <ShareSetupLink
                    hintClassName={hintClassName}
                    primaryAction={primaryAction}
                    sendLink={handoff.sendLink}
                />
            ) : handoff.kind === "copy-link" ? (
                <>
                    <CopyToClipboardButton
                        className={primaryAction.className}
                        failureToast={unavailableLink}
                        label="Copy link"
                        size={primaryAction.size}
                        successToast={{
                            description: "Open it on the computer where your agent runs.",
                            title: "Link copied",
                        }}
                        value={mortyAddress()}
                    >
                        <Link aria-hidden="true" className="size-4" />
                        <span>Copy link</span>
                    </CopyToClipboardButton>
                    <p className={hintClassName}>{handoffHint}</p>
                </>
            ) : (
                <CopyToClipboardButton
                    className={primaryAction.className}
                    failureToast={{
                        description: "Expand setup details to copy the prompt manually.",
                        title: "Could not copy",
                    }}
                    label="Copy setup prompt"
                    size={primaryAction.size}
                    successToast={{
                        description: "Paste into your agent, then open the link it returns.",
                        title: "Copied",
                    }}
                    idleContent={<SetupPromptIdleHint />}
                    copiedContent={
                        <>
                            <Check aria-hidden="true" className="size-4" />
                            Copied
                        </>
                    }
                    successContent={<SetupPromptCopiedHint />}
                    value={setupInstruction}
                >
                    <Copy aria-hidden="true" className="size-4" />
                    <span>Copy setup prompt</span>
                </CopyToClipboardButton>
            )}
            <SetupPromptDetails prompt={setupInstruction} />
        </div>
    );
}
