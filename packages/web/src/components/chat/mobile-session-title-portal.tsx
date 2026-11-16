import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { dataTestId } from "../../data-testid.ts";

/**
 * Recorded effect exception: the effect only resolves the portal's DOM slot
 * after mount — DOM-ephemeral state, no asynchronous workflow.
 */
export function MobileSessionTitlePortal({ children }: { readonly children: ReactNode }) {
    const [slot, setSlot] = useState<HTMLElement | null>(null);
    useEffect(() => {
        setSlot(document.getElementById(dataTestId.mobileSessionTitleSlot));
    }, []);
    if (slot === null) {
        return null;
    }
    return createPortal(
        <div className="pointer-events-auto flex min-w-0 w-full max-w-full justify-center overflow-visible">
            {children}
        </div>,
        slot,
    );
}
