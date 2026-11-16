/**
 * Header row shared by chat sheets presented from the bottom edge on phones.
 * A 40px action centered in the 64px row sits 12px from the top edge, so the
 * gutter on a side that carries an action is 12px too; the title side keeps 20px.
 */
export const mobileSheetHeaderClassName =
    "relative z-[12] flex h-16 shrink-0 items-center justify-between gap-2 pr-3 pl-5";

/**
 * Panel surface shared by every phone sheet. The fill is opaque card rather than
 * a translucent frost so a sheet reads the same as the pane behind the overlay,
 * and the 1px white hairline draws the sheet edge against it. The bottom edge
 * sits on the screen edge instead of against the pane, so it carries no stroke.
 */
export const mobileSheetSurfaceClassName =
    "max-sm:border-[1px] max-sm:border-white max-sm:border-b-0 max-sm:bg-card max-sm:backdrop-blur-none";

export const mobileSheetTitleRowClassName = "flex h-16 items-center sm:h-auto sm:py-4";

/**
 * Title typography shared by chat sheets presented from the bottom edge on phones:
 * one 16px semibold line in the primary text color, so sheet titles read the same
 * as the Agent configuration panel. The size is an arbitrary property because
 * tailwind-merge reads a bare `text-16` as a color and would drop it next to one.
 */
export const mobileSheetTitleClassName =
    "font-inter [font-size:16px] leading-6 font-semibold tracking-normal text-foreground";

export const mobileSheetCloseButtonPositionClassName = "max-sm:top-3! max-sm:right-3!";

export const mobileSheetSessionRowClassName =
    // The size uses an arbitrary property so tailwind-merge does not read it as a text color and drop it.
    "box-border h-10 w-full min-w-0 items-center gap-2 rounded-[20px] px-4 text-left [font-size:15px] leading-[22px] font-medium text-copy-secondary outline-none transition-[background-color,color] duration-150 hover:bg-morty-fill-opacity-2 hover:text-foreground keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:text-copy-secondary disabled:hover:bg-transparent disabled:hover:text-copy-secondary motion-reduce:transition-none sm:h-9 sm:px-3.5 sm:[font-size:13px]";
