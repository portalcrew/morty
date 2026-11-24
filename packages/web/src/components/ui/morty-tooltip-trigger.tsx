import { Tooltip } from "radix-ui";
import type { ComponentProps } from "react";
import { isKeyboardInputModality } from "../../input-modality.ts";

/**
 * Opens its tooltip on keyboard focus only. A clicked trigger keeps focus, and
 * the browser focuses it again when the window regains focus or a dialog it
 * opened closes; that focus must not show the tooltip.
 */
export function MortyTooltipTrigger({ onFocus, ...props }: ComponentProps<typeof Tooltip.Trigger>) {
    return (
        <Tooltip.Trigger
            {...props}
            onFocus={(event) => {
                onFocus?.(event);
                if (!isKeyboardInputModality()) {
                    // Radix skips its own open handler for a prevented event.
                    event.preventDefault();
                }
            }}
        />
    );
}
