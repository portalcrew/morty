import { Slot } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

import { buttonIconEdges } from "./button-icon-edges.ts";

const variants = {
    primary: "border-transparent bg-foreground text-background hover:bg-foreground/85 active:bg-foreground/75",
    outline: "border-border bg-transparent text-foreground hover:bg-accent active:bg-morty-fill-opacity-4",
    ghost: "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground active:bg-morty-fill-opacity-4 active:text-foreground",
    destructive: "border-transparent bg-destructive text-white hover:bg-destructive/85 active:bg-destructive/75",
};
/**
 * Text-edge padding is pl/pr. Icon-edge classes override one side and stay smaller than that padding.
 * Font sizes use [font-size:…] so cn/tailwind-merge does not drop variant text colors (e.g. text-background).
 */
const sizes = {
    default: "min-h-9 gap-1.5 py-1.5 pl-4 pr-4 [font-size:13px] [&_svg]:size-4",
    lg: "h-10 gap-1.5 py-0 pl-5 pr-5 [font-size:15px] leading-6 [&_svg]:size-4.5",
    sm: "min-h-8 gap-1 py-1.5 pl-3.5 pr-3.5 [font-size:12px] leading-4 [&_svg]:size-3.5",
    xs: "h-7 gap-1 pl-3 pr-3 [font-size:12px] leading-4 [&_svg]:size-3",
    icon: "size-9 p-0 [font-size:16px] [&_svg]:size-4",
};
const iconEdgePadding = {
    default: { leading: "pl-3", trailing: "pr-3" },
    lg: { leading: "pl-4", trailing: "pr-4" },
    sm: { leading: "pl-2.5", trailing: "pr-2.5" },
    xs: { leading: "pl-2", trailing: "pr-2" },
    icon: { leading: "", trailing: "" },
} as const;

function buttonClassName(
    variant: keyof typeof variants,
    size: keyof typeof sizes,
    className: string,
    children: ReactNode,
): string {
    const edges = buttonIconEdges(children);
    const iconPad = iconEdgePadding[size];
    return cn(
        "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-lg border font-medium outline-none transition-colors duration-150 motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50 active:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0",
        variants[variant],
        sizes[size],
        edges.leading && iconPad.leading,
        edges.trailing && iconPad.trailing,
        className,
    );
}

export function Button({
    variant = "primary",
    size = "default",
    type = "button",
    asChild = false,
    className = "",
    children,
    ...props
}: Readonly<ComponentProps<"button">> & {
    readonly variant?: keyof typeof variants;
    readonly size?: keyof typeof sizes;
    readonly asChild?: boolean;
    readonly children?: ReactNode;
}) {
    const Component = asChild ? Slot.Root : "button";
    return (
        <Component
            {...props}
            {...(asChild ? {} : { type })}
            className={buttonClassName(variant, size, className, asChild ? null : children)}
        >
            {children}
        </Component>
    );
}
