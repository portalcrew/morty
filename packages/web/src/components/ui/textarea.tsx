import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export const formFieldShellClassName =
    "rounded-md border border-border bg-background pt-2 pr-1.5 pb-1.5 pl-3 has-[:focus]:border-ring has-[:focus]:shadow-[var(--focus-ring-shadow)]";
export const formTextareaClassName =
    "min-h-16 resize-y bg-transparent p-0 text-[13px] leading-5 placeholder:text-[13px] lg:text-[13px]";

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
    return (
        <textarea
            className={cn(
                "flex min-h-16 w-full resize-none bg-transparent px-1 py-1 text-base leading-6 text-foreground outline-none placeholder:text-[15px] focus-visible:outline-none! focus-visible:shadow-none! disabled:cursor-not-allowed disabled:opacity-50 lg:text-[15px]",
                className,
            )}
            data-slot="textarea"
            {...props}
        />
    );
}
