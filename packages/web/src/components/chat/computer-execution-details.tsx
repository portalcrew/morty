import { type ReactNode, useState } from "react";
import { dataTestId } from "../../data-testid.ts";
import type { ExecutionContext } from "./execution-context.ts";
import { ExecutionDetailsDialog } from "./execution-details-dialog.tsx";

/** Owns the details dialog so a view can open it without calling a state hook. */
export function ComputerExecutionDetails({
    children,
    context,
    rows,
}: {
    readonly children: (details: { readonly open: boolean; readonly openDetails: () => void }) => ReactNode;
    readonly context: ExecutionContext;
    readonly rows?: ReactNode;
}) {
    const [open, setOpen] = useState(false);
    return (
        <>
            {children({ open, openDetails: () => setOpen(true) })}
            <ExecutionDetailsDialog
                context={context}
                rows={rows}
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
