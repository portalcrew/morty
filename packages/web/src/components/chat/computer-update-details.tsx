import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useStore } from "zustand";
import type { ComputerUpdateState, ComputerUpdateStoreApi } from "../../view-models/chat/computer-update-store.ts";
import { Button } from "../ui/cloud-button.tsx";
import { CopyableCommand } from "./copyable-command.tsx";

// `--yes` keeps the update on that computer from stopping at npx's install prompt.
const MORTY_RESTART_COMMAND = "npx --yes @portalcrew/morty@latest restart";

type AvailableUpdate = Extract<ComputerUpdateState, { readonly kind: "available" }>;

const detailClassName = "mt-1 block text-xs text-muted-foreground";

/** Only a busy Computer is a condition to wait out; every other notice is a failure and reads as one. */
function UpdateNotice({ update }: { readonly update: AvailableUpdate }) {
    switch (update.notice) {
        case null:
            return null;
        case "busy":
            return (
                <span className={detailClassName} role="status">
                    Morty updates when no task is running. Try again once this computer's tasks finish.
                </span>
            );
        case "download":
            return (
                <span className="mt-1 block text-xs text-destructive" role="alert">
                    This computer couldn't download {update.latest}. Check its network, then try again.
                </span>
            );
        case "npx":
            return (
                <span className="mt-1 block text-xs text-destructive" role="alert">
                    This computer has no npx, so Morty can't download the update there.
                </span>
            );
        case "failed":
            return (
                <span className="mt-1 block text-xs text-destructive" role="alert">
                    The update didn't start.
                </span>
            );
        case "incomplete":
            return (
                <span className="mt-1 block text-xs text-destructive" role="alert">
                    The update didn't complete.
                </span>
            );
    }
}

function UpdateAction({
    update,
    onUpdate,
}: {
    readonly update: AvailableUpdate;
    readonly onUpdate: (() => void) | null;
}) {
    if (!update.remote) {
        return (
            <span className={detailClassName}>
                <span className="mb-1.5 block">
                    Update on this computer when no task is running. After that, you can update from here.
                </span>
                <CopyableCommand command={MORTY_RESTART_COMMAND} />
            </span>
        );
    }
    if (onUpdate === null) {
        return <span className={detailClassName}>You can update once this computer is online.</span>;
    }
    return (
        <Button className="mt-2.5" onClick={onUpdate} size="sm" variant="outline">
            {update.notice === null ? "Update" : "Try again"}
        </Button>
    );
}

function Progress({ children }: { readonly children: ReactNode }) {
    return (
        <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
            <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />
            {children}
        </span>
    );
}

function UpdateDetails({
    state,
    onUpdate,
}: {
    readonly state: ComputerUpdateState;
    readonly onUpdate: (() => void) | null;
}) {
    switch (state.kind) {
        case "unknown":
            return null;
        case "current":
            return <span>{state.running}</span>;
        case "available":
            return (
                <>
                    <span className="block">{state.running}</span>
                    <span className={detailClassName}>{state.latest} is available.</span>
                    <UpdateNotice update={state} />
                    <UpdateAction onUpdate={onUpdate} update={state} />
                </>
            );
        case "updating":
            return (
                <>
                    <span className="block">{state.running}</span>
                    <Progress>Downloading {state.latest}…</Progress>
                </>
            );
        case "restarting":
            return (
                <>
                    <span className="block">{state.running}</span>
                    <Progress>Restarting Morty…</Progress>
                </>
            );
        case "updated":
            return (
                <>
                    <span className="block">{state.version}</span>
                    <span className={detailClassName} role="status">
                        Updated.
                    </span>
                </>
            );
    }
}

export function ComputerUpdateDetails({
    online,
    update,
}: {
    readonly online: boolean;
    readonly update: ComputerUpdateStoreApi;
}) {
    const { state, update: start } = useStore(update);
    if (state.kind === "unknown") {
        return null;
    }
    return (
        <>
            <dt className="shrink-0 whitespace-nowrap text-muted-foreground">Morty version</dt>
            <dd className="min-w-0 text-foreground">
                {/* Only the page closing during an update rejects, and nothing is left to show it to. */}
                <UpdateDetails onUpdate={online ? () => void start().catch(() => undefined) : null} state={state} />
            </dd>
        </>
    );
}
