export const centeredOverlayHorizontalInsetClassName = "w-[calc(100%-2rem)]";

/** Literal class strings so Tailwind can scan them (dynamic `` `max-w-[${px}px]` `` is not picked up). */
export const dialogDesktopMaxWidthClassName = {
    standard: "max-w-[520px]",
    medium: "max-w-[680px]",
    wide: "max-w-[960px]",
} as const;

export const sheetDialogDesktopMaxWidthClassName = "sm:max-w-[840px]";

export const executionDetailsDialogDesktopWidthClassName = "sm:w-[520px]";

export const agentConfigurationPopoverWidthClassName = "w-[min(calc(100vw-2rem),360px)]";
