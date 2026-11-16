export const overlaySurfaceRadiusClassName = "rounded-overlay";

export const overlayTriggerOffsetPx = 6;

export {
    agentConfigurationPopoverWidthClassName,
    executionDetailsDialogDesktopWidthClassName,
} from "./overlay-width.ts";

export const overlaySurfacePanelClassName =
    "border-[1px] border-white bg-background shadow-[0_16px_42px_rgba(0,0,0,0.14)]";

export const overlayMenuSeparatorClassName = "h-[0.5px] bg-black/[0.06]";

/** Radix dismissable layers honor this at runtime; some primitive typings omit it. */
export type OverlayContentOpenAutoFocus = {
    readonly onOpenAutoFocus?: (event: Event) => void;
};

export function preventOverlayOpenAutoFocus(event: Event): void {
    event.preventDefault();
}
