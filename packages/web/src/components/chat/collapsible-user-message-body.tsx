import { ChevronDown } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useStore } from "zustand";
import { cn } from "@/lib/utils";
import type { UserMessageCollapseStore } from "../../view-models/chat/user-message-collapse-store.ts";

const COLLAPSE_THRESHOLD_HEIGHT = 15 * 24;
const COLLAPSED_HEIGHT = 11 * 24;

/** Measures the unclipped body; attachments are rendered by callers outside this component. */
export function CollapsibleUserMessageBody({
    children,
    messageId,
    store,
}: {
    readonly children: ReactNode;
    readonly messageId: string;
    readonly store: UserMessageCollapseStore;
}) {
    const bodyId = useId();
    const clipRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const originalTabIndexes = useRef(new WeakMap<HTMLAnchorElement, string | null>());
    const [naturalHeight, setNaturalHeight] = useState<number | null>(null);
    const expanded = useStore(store, (state) => state.expandedIds.has(messageId));
    const collapsible = naturalHeight !== null && naturalHeight > COLLAPSE_THRESHOLD_HEIGHT;
    const collapsed = collapsible && !expanded;

    useEffect(() => {
        const content = contentRef.current;
        if (content === null) {
            return;
        }
        const measure = () => setNaturalHeight(content.scrollHeight);
        measure();
        const resize = new ResizeObserver(measure);
        resize.observe(content);
        return () => resize.disconnect();
    }, []);

    useEffect(() => {
        const content = contentRef.current;
        const clip = clipRef.current;
        if (content === null || clip === null) {
            return;
        }
        const original = originalTabIndexes.current;
        const syncLinks = () => {
            const clipBottom = clip.getBoundingClientRect().bottom;
            for (const anchor of content.querySelectorAll("a")) {
                if (!original.has(anchor)) {
                    original.set(anchor, anchor.getAttribute("tabindex"));
                }
                if (collapsed && anchor.getBoundingClientRect().top >= clipBottom) {
                    anchor.tabIndex = -1;
                } else {
                    const tabIndex = original.get(anchor);
                    if (tabIndex === null) {
                        anchor.removeAttribute("tabindex");
                    } else if (tabIndex !== undefined) {
                        anchor.setAttribute("tabindex", tabIndex);
                    }
                }
            }
        };
        syncLinks();
        const resize = new ResizeObserver(syncLinks);
        resize.observe(clip);
        resize.observe(content);
        const mutations = new MutationObserver(syncLinks);
        mutations.observe(content, { childList: true, subtree: true });
        return () => {
            resize.disconnect();
            mutations.disconnect();
            for (const anchor of content.querySelectorAll("a")) {
                const tabIndex = original.get(anchor);
                if (tabIndex === null) {
                    anchor.removeAttribute("tabindex");
                } else if (tabIndex !== undefined) {
                    anchor.setAttribute("tabindex", tabIndex);
                }
            }
        };
    }, [collapsed]);

    return (
        <div className="flex min-w-0 flex-col gap-1">
            <div className="relative min-w-0">
                <div
                    className={cn(
                        "min-w-0",
                        collapsible &&
                            "overflow-clip transition-[max-height] duration-200 ease-out motion-reduce:transition-none",
                    )}
                    id={bodyId}
                    ref={clipRef}
                    style={collapsible ? { maxHeight: collapsed ? COLLAPSED_HEIGHT : naturalHeight } : undefined}
                >
                    <div className="flex min-w-0 flex-col gap-1.5" ref={contentRef}>
                        {children}
                    </div>
                </div>
                {collapsible && (
                    <span
                        aria-hidden="true"
                        className={cn(
                            "pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-user-message-surface to-transparent transition-opacity duration-200 ease-out motion-reduce:transition-none",
                            collapsed ? "opacity-100" : "opacity-0",
                        )}
                    />
                )}
            </div>
            {collapsible && (
                <button
                    aria-controls={bodyId}
                    aria-expanded={!collapsed}
                    className="-mb-0.5 flex h-7 w-full items-center justify-start gap-1 rounded-sm text-left text-[13px] text-muted-foreground hover:text-foreground keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/50"
                    onClick={() => store.getState().toggle(messageId)}
                    type="button"
                >
                    {collapsed ? "Show more" : "Show less"}
                    <ChevronDown
                        aria-hidden="true"
                        className={cn(
                            "size-3 transition-transform duration-200 ease-out motion-reduce:transition-none",
                            !collapsed && "rotate-180",
                        )}
                    />
                </button>
            )}
        </div>
    );
}
