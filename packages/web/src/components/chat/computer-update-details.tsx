import { Check, Copy, LoaderCircle } from "lucide-react";
import { useStore } from "zustand";
import type { ComputerUpdateState, ComputerUpdateStoreApi } from "../../view-models/chat/computer-update-store.ts";
import { Button } from "../ui/cloud-button.tsx";
import { CopyToClipboardButton } from "../ui/copy-to-clipboard-button.tsx";
import { ScrollArea } from "../ui/scroll-area.tsx";

// `--yes` keeps the update on that computer from stopping at npx's install prompt.
const MORTY_RESTART_COMMAND = "npx --yes @portalcrew/morty@latest restart";

type AvailableUpdate = Extract<ComputerUpdateState, { readonly kind: "available" }>;

function noticeText(update: AvailableUpdate): string | null {
    switch (update.notice) {
        case null:
            return null;
        case "busy":
            return "Morty updates when no task is running on this computer. Try again once its tasks finish.";
        case "download":
            return `This computer couldn't download Morty ${update.latest}. Check its network, then try again.`;
        case "failed":
            return `The update didn't start. This computer still runs Morty ${update.running}.`;
        case "incomplete":
            return `The update didn't complete. This computer still runs Morty ${update.running}.`;
    }
}

function RestartCommand() {
    return (
        <span className="mt-2 flex min-w-0 max-w-full items-center gap-1">
            <ScrollArea className="max-w-full shrink rounded-md bg-muted" orientation="horizontal">
                <code className="whitespace-nowrap px-1.5 py-0.5 font-mono text-[11px] leading-4 text-foreground">
                    {MORTY_RESTART_COMMAND}
                </code>
            </ScrollArea>
            <CopyToClipboardButton
                className="w-7 px-0"
                copiedContent={<Check aria-hidden="true" className="size-3.5" />}
                failureToast={{ description: "Select the command and copy it manually.", title: "Could not copy" }}
                label="Copy update command"
                size="xs"
                successToast={{ description: "Run it in a terminal on that computer.", title: "Command copied" }}
                value={MORTY_RESTART_COMMAND}
                variant="ghost"
            >
                <Copy aria-hidden="true" className="size-3.5" />
            </CopyToClipboardButton>
        </span>
    );
}

function AvailableUpdateDetails({
    update,
    onUpdate,
}: {
    readonly update: AvailableUpdate;
    readonly onUpdate: () => void;
}) {
    const notice = noticeText(update);
    return (
        <>
            <span className="block">
                Morty {update.latest} is available. This computer runs {update.running}.
            </span>
            {notice !== null && (
                <span className="mt-1 block text-xs text-muted-foreground" role="status">
                    {notice}
                </span>
            )}
            {update.remote ? (
                <Button className="mt-2.5" onClick={onUpdate} size="sm" variant="outline">
                    Update
                </Button>
            ) : (
                <span className="mt-1 block text-xs text-muted-foreground">
                    When no task is running, run this on that computer. After this update, you can update from here.
                    <RestartCommand />
                </span>
            )}
        </>
    );
}

function UpdateDetails({ state, onUpdate }: { readonly state: ComputerUpdateState; readonly onUpdate: () => void }) {
    switch (state.kind) {
        case "unknown":
            return null;
        case "current":
            return <span>{state.running}</span>;
        case "available":
            return <AvailableUpdateDetails onUpdate={onUpdate} update={state} />;
        case "updating":
        case "restarting":
            return (
                <span className="inline-flex items-center gap-1.5" role="status">
                    <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />
                    {state.kind === "updating"
                        ? `Downloading Morty ${state.latest}…`
                        : `Restarting into Morty ${state.latest}…`}
                </span>
            );
        case "updated":
            return <span role="status">Updated to Morty {state.version}.</span>;
    }
}

export function ComputerUpdateDetails({ update }: { readonly update: ComputerUpdateStoreApi }) {
    const { state, update: start } = useStore(update);
    if (state.kind === "unknown") {
        return null;
    }
    return (
        <>
            <dt className="shrink-0 whitespace-nowrap text-muted-foreground">Morty</dt>
            <dd className="min-w-0 text-foreground">
                {/* Only the page closing during an update rejects, and nothing is left to show it to. */}
                <UpdateDetails onUpdate={() => void start().catch(() => undefined)} state={state} />
            </dd>
        </>
    );
}
