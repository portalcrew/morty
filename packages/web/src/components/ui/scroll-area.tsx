import { ScrollArea as Primitive } from "radix-ui";
import type { AriaRole, ComponentProps, UIEventHandler } from "react";

import { cn } from "@/lib/utils";

/**
 * Product scrollports use this instead of a relay scrollbar.
 * The bar is as tall as the scrollport. `overflow-hidden` on the root clips it
 * to the container's border radius without shortening the bar.
 */
type ScrollAreaProps = ComponentProps<typeof Primitive.Root> & {
    readonly orientation?: "vertical" | "horizontal" | "both";
    readonly onViewportScroll?: UIEventHandler<HTMLDivElement>;
    readonly viewportClassName?: string;
    readonly viewportRef?: ComponentProps<typeof Primitive.Viewport>["ref"];
    readonly viewportLabel?: string | undefined;
    readonly viewportRole?: AriaRole | undefined;
    readonly viewportStyle?: ComponentProps<typeof Primitive.Viewport>["style"];
};

export function ScrollArea({
    children,
    className,
    onViewportScroll,
    orientation = "vertical",
    type = "auto",
    viewportClassName,
    viewportRef,
    viewportRole,
    viewportStyle,
    viewportLabel,
    ...props
}: ScrollAreaProps) {
    return (
        <Primitive.Root
            className={cn("relative rounded-[inherit]", className, "overflow-hidden")}
            data-slot="scroll-area"
            type={type}
            {...props}
        >
            <Primitive.Viewport
                className={cn("w-full rounded-[inherit]", viewportClassName)}
                data-slot="scroll-area-viewport"
                role={viewportRole ?? (viewportLabel === undefined ? undefined : "region")}
                aria-label={viewportLabel}
                onScroll={onViewportScroll}
                ref={viewportRef}
                style={viewportStyle}
            >
                {children}
            </Primitive.Viewport>
            {orientation !== "horizontal" ? <ScrollBar /> : null}
            {orientation !== "vertical" ? <ScrollBar orientation="horizontal" /> : null}
            <Primitive.Corner className="bg-transparent" />
        </Primitive.Root>
    );
}

function ScrollBar({ className, orientation = "vertical", ...props }: ComponentProps<typeof Primitive.Scrollbar>) {
    return (
        <Primitive.Scrollbar
            className={cn(
                "group/scroll-area-scrollbar flex touch-none select-none p-px transition-colors duration-150 motion-reduce:transition-none",
                orientation === "vertical" ? "h-full w-2" : "h-2 w-full flex-col",
                className,
            )}
            data-slot="scroll-area-scrollbar"
            orientation={orientation}
            {...props}
        >
            <Primitive.Thumb
                className="relative flex-1 rounded-full bg-[#d4d7db] opacity-0 transition-opacity duration-150 motion-reduce:transition-none group-hover/scroll-area-scrollbar:opacity-100 group-active/scroll-area-scrollbar:opacity-100 active:opacity-100 hover:bg-morty-text-4"
                data-slot="scroll-area-thumb"
            />
        </Primitive.Scrollbar>
    );
}
