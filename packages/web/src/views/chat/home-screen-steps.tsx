import { Check, Copy, Share } from "lucide-react";
import type { ReactNode } from "react";
import { type StoreApi, useStore } from "zustand";
import { Button } from "../../components/ui/cloud-button.tsx";
import { MortyAlert } from "../../components/ui/morty-alert.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { formatMoment } from "../../view-models/chat/access-presentation.ts";
import type { HomeScreenLinkStore } from "../../view-models/chat/home-screen-link-store.ts";

function Step({
    number,
    title,
    children,
}: {
    readonly number: number;
    readonly title: string;
    readonly children?: ReactNode;
}) {
    return (
        <li className="flex gap-3">
            <span
                aria-hidden="true"
                className="flex size-6 shrink-0 items-center justify-center rounded-full bg-morty-fill-opacity-3 text-12 font-semibold text-foreground"
            >
                {number}
            </span>
            <div className="min-w-0 flex-1 space-y-2 pt-0.5">
                <p className="text-14 font-medium leading-5 text-foreground">{title}</p>
                {children}
            </div>
        </li>
    );
}

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
                        <Check aria-hidden="true" />
                        Link copied
                    </Button>
                    <p className="text-13 leading-5 text-muted-foreground" role="status">
                        It works once, until {formatMoment(state.expiresAt)}.
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
        <ol aria-label="Steps" className="space-y-5">
            <Step number={1} title="Copy a link for the app">
                <CopyLink store={store} />
            </Step>
            <Step number={2} title="Add Morty to your Home Screen">
                <p className="text-13 leading-5 text-muted-foreground">
                    Tap <Share aria-label="Share" className="inline size-4 align-[-3px]" /> Share (in the ⋯ menu on
                    newer iOS), then Add to Home Screen.
                </p>
            </Step>
            <Step number={3} title="Open Morty from your Home Screen and tap Paste link" />
        </ol>
    );
}
