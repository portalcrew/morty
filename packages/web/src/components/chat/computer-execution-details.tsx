import { type ReactNode, useState } from "react";
import { dataTestId } from "../../data-testid.ts";
import type { ComputerUpdateStoreApi } from "../../view-models/chat/computer-update-store.ts";
import type { ExecutionContext } from "./execution-context.ts";
import { ExecutionDetailsDialog } from "./execution-details-dialog.tsx";

/** Owns the details dialog so a view can open it without calling a state hook. */
export function ComputerExecutionDetails({
    children,
    context,
    update,
}: {
    readonly children: (details: { readonly open: boolean; readonly openDetails: () => void }) => ReactNode;
    readonly context: ExecutionContext;
    readonly update: ComputerUpdateStoreApi;
}) {
    const [open, setOpen] = useState(false);
    return (
        <>
            {children({ open, openDetails: () => setOpen(true) })}
            <ExecutionDetailsDialog
                context={context}
                update={update}
                onOpenChange={setOpen}
                open={open}
                returnFocus={() => {
                    document
                        .querySelector<HTMLButtonElement>(`[data-testid="${dataTestId.botConnectionStatus}"]`)
                        ?.focus();
                }}
            />
        </>
    );
}
