import { Check, Copy, Share } from "lucide-react";
import { type StoreApi, useStore } from "zustand";
import { Button } from "../../components/ui/cloud-button.tsx";
import { MortyAlert } from "../../components/ui/morty-alert.tsx";
import { NumberedStep } from "../../components/ui/numbered-step.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { formatMoment } from "../../view-models/chat/access-presentation.ts";
import type { HomeScreenLinkStore } from "../../view-models/chat/home-screen-link-store.ts";

function CopyLink({ store }: { readonly store: StoreApi<HomeScreenLinkStore> }) {
    const { state, copy } = useStore(store);
    switch (state.kind) {
        case "idle":
        case "copying":
            return (
                <>
                    <Button
                        aria-busy={state.kind === "copying"}
                        disabled={state.kind === "copying"}
                        onClick={copy}
                        variant="primary"
                    >
                        {state.kind === "copying" ? (
                            <Spinner className="text-background" label="Copying" />
                        ) : (
                            <Copy aria-hidden="true" />
                        )}
                        Copy link
                    </Button>
                    <p className="text-13 leading-5 text-muted-foreground">It works once, for 10 minutes.</p>
                </>
            );
        case "copied":
            return (
                <>
                    <Button onClick={copy} variant="outline">
                        <Copy aria-hidden="true" />
                        Copy again
                    </Button>
                    <p className="flex items-center gap-1.5 text-13 leading-5 text-muted-foreground" role="status">
                        <Check aria-hidden="true" className="size-4 shrink-0" />
                        Copied. It works once, until {formatMoment(state.expiresAt)}.
                    </p>
                </>
            );
        case "failed":
            return (
                <>
                    <MortyAlert>Morty couldn’t copy the link.</MortyAlert>
                    <Button onClick={copy} variant="primary">
                        <Copy aria-hidden="true" />
                        Try again
                    </Button>
                </>
            );
    }
}

export function HomeScreenSteps({ store }: { readonly store: StoreApi<HomeScreenLinkStore> }) {
    return (
        <ol aria-label="Steps" className="space-y-5 text-left">
            <NumberedStep number={1} title="Copy a link">
                <CopyLink store={store} />
            </NumberedStep>
            <NumberedStep number={2} title="Add to Home Screen">
                <p className="text-13 leading-5 text-muted-foreground">
                    Tap <Share aria-label="Share" className="inline size-4 align-[-3px]" /> Share (in the ⋯ menu on
                    newer iOS), then Add to Home Screen.
                </p>
            </NumberedStep>
            <NumberedStep number={3} title="Open Morty from your Home Screen">
                <p className="text-13 leading-5 text-muted-foreground">
                    Tap Paste link. After that, it opens straight to Morty.
                </p>
            </NumberedStep>
        </ol>
    );
}
