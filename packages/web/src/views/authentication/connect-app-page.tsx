import { ClipboardPaste } from "lucide-react";
import { type StoreApi, useStore } from "zustand";
import { Button } from "../../components/ui/cloud-button.tsx";
import { inputClassName } from "../../components/ui/input.tsx";
import { MortyAlert } from "../../components/ui/morty-alert.tsx";
import { NumberedStep } from "../../components/ui/numbered-step.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import type { ConnectAppStore } from "../../view-models/authentication/connect-app-store.ts";
import {
    BackToLastComputer,
    SetupCardDescription,
    SetupCardSection,
    SetupCardShell,
    SetupCardTitle,
    setupPrimaryButtonClassName,
    setupPrimaryButtonSize,
} from "../setup/setup-card-shell.tsx";

function problem(kind: ConnectAppStore["state"]["kind"]): string | null {
    switch (kind) {
        case "not-a-link":
            return "That isn’t a Morty link. Copy the link again in Safari.";
        case "nothing-copied":
            return "Nothing is copied yet. In Safari, tap Copy link first.";
        case "clipboard-unavailable":
            return "Morty couldn’t read the clipboard. Paste the link below instead.";
        case "waiting":
        case "reading":
        case "opening":
            return null;
    }
}

export function ConnectAppPage({
    notice,
    returnHref,
    store,
}: {
    readonly notice: "access-ended" | "none";
    readonly returnHref: string | null;
    readonly store: StoreApi<ConnectAppStore>;
}) {
    const { state, paste, submit } = useStore(store);
    const busy = state.kind === "reading" || state.kind === "opening";
    const message = problem(state.kind);
    return (
        <SetupCardShell
            pageAction={returnHref === null ? undefined : <BackToLastComputer href={returnHref} />}
            titleId="connect-app-title"
        >
            <SetupCardTitle id="connect-app-title">Connect the Morty app</SetupCardTitle>
            <SetupCardDescription>
                {notice === "access-ended" ? "This app’s access ended. " : ""}It signs in separately from Safari.
            </SetupCardDescription>
            <ol aria-label="Steps" className="mt-5 space-y-4 text-left">
                <NumberedStep number={1} title="In Safari, open Morty">
                    <p className="text-13 leading-5 text-muted-foreground">
                        Tap Add on the Home Screen suggestion, or open the Morty menu and tap Add to Home Screen.
                    </p>
                </NumberedStep>
                <NumberedStep number={2} title="Tap Copy link" />
                <NumberedStep number={3} title="Come back, tap Paste link, then Allow Paste" />
            </ol>
            <SetupCardSection className="mt-5 space-y-4">
                <Button
                    aria-busy={busy}
                    className={setupPrimaryButtonClassName}
                    disabled={busy}
                    onClick={paste}
                    size={setupPrimaryButtonSize}
                >
                    {busy ? (
                        <Spinner className="text-background" label="Opening" />
                    ) : (
                        <ClipboardPaste aria-hidden="true" />
                    )}
                    Paste link
                </Button>
                {message !== null ? <MortyAlert>{message}</MortyAlert> : null}
                <form
                    className="flex gap-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        submit(String(new FormData(event.currentTarget).get("link") ?? ""));
                    }}
                >
                    <input
                        aria-label="Morty link"
                        autoCapitalize="none"
                        autoComplete="off"
                        className={inputClassName}
                        disabled={busy}
                        name="link"
                        placeholder="Or paste the link here"
                        spellCheck={false}
                        type="url"
                    />
                    <Button disabled={busy} type="submit" variant="outline">
                        Open
                    </Button>
                </form>
            </SetupCardSection>
        </SetupCardShell>
    );
}
