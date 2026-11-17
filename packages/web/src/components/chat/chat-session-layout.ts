const chatSessionContentInsetClassName = "px-5 sm:px-6";

export const chatSessionColumnClassName = `mx-auto w-full min-w-0 max-w-[920px] ${chatSessionContentInsetClassName}`;

export const chatSessionInteractionColumnClassName =
    "mx-auto w-full min-w-0 px-3 sm:w-[min(920px,calc(100%-24px))] sm:px-0";

/**
 * Without a floating composer notice the log reaches 16px under the composer
 * stack; while one is up, `--composer-overlay-block` replaces that overhang
 * with the notice's own height, so the log's visible bottom edge stops at the
 * notice's top edge and no scroll position passes under its frost.
 * The product scrollbar owns the frame; padding stays on the actual scroll viewport.
 */
export const chatSessionMessageScrollAreaClassName = "min-h-0 flex-1 mb-[var(--composer-overlay-block,-1rem)]";
export const chatSessionMessageViewportClassName = "pt-6 pb-[72px] sm:pt-10 [&>div]:!block [&>div]:!w-full";

export const chatSessionMessageColumnClassName = `${chatSessionColumnClassName} font-inter text-foreground`;

/**
 * Composer keeps 12px side gutters at every breakpoint (on `sm:` the width calc
 * provides them). The pane section uses `overflow-clip`, so a full-bleed card
 * would have its shadow clipped away at the section edge.
 *
 * Mobile bottom padding keeps the gradient dock behind the iOS home indicator
 * while its input stays above the safe area. iOS keeps reporting the full inset
 * while the software keyboard covers the indicator, so the composer drops back
 * to a 12px gutter while `useSoftwareKeyboardMarker` reports the keyboard open.
 */
export const chatSessionComposerClassName =
    "relative z-10 mx-auto w-full min-w-0 shrink-0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] data-[software-keyboard=open]:pb-3 sm:mt-0 sm:mb-[max(0.75rem,env(safe-area-inset-bottom))] sm:w-[min(920px,calc(100%-24px))] sm:px-0 sm:pb-0";

/**
 * Fills the conversation card. Background, radius, and the outer inset stay on
 * the parent section so they are not painted twice.
 *
 * `overflow-clip` rather than `overflow-hidden`: a clipped box cannot hold a
 * scroll offset, so revealing a control deep in the pane (focus, find-in-page,
 * scrollIntoView) can never scroll the header and composer out of the card.
 */
export const chatSessionPaneFillClassName = "flex min-h-0 min-w-0 flex-1 flex-col overflow-clip";

/**
 * No backdrop-filter here. It would make this pane the backdrop root, and the
 * composer notice could no longer blur the messages scrolling behind it.
 *
 * Mobile sits flush to the viewport edges; only the desktop card keeps insets.
 */
export const chatSessionPaneSectionClassName = `relative z-20 ${chatSessionPaneFillClassName} sm:rounded-t-[20px] sm:rounded-b-[32px] sm:border-[1px] sm:border-white sm:bg-card/90 sm:shadow-module sm:my-2 sm:ml-0 sm:mr-2`;

export const chatSessionPaneEnterClassName =
    "flex min-h-0 min-w-0 flex-1 flex-col motion-reduce:animate-none sm:animate-cloud-enter";

export const chatSessionExecutionHeaderClassName = "flex h-12 shrink-0 items-center gap-4 px-4";

export const chatSessionMessageItemClassName = "mt-4 first:mt-0";

/**
 * Agent output for one user turn (text, tools, thinking, completion notices).
 * Children carry per-type vertical margins (see replyItemMarginClassName in
 * the session pane) instead of a uniform gap, so adjacent margins collapse to
 * the larger value. The 10px top margin keeps the reply tight under the strip
 * the user message reserves for its copy button; `pb-8` (12px while
 * generating) is the turn's bottom breathing room.
 */
export const chatSessionAgentReplyGroupClassName = "mt-2.5 first:mt-0 pb-8";
