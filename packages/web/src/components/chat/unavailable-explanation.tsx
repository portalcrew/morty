import type { ReactElement } from "react";
import { cn } from "../../lib/utils.ts";
import { overlaySurfacePanelClassName, overlaySurfaceRadiusClassName } from "../ui/overlay-surface.ts";
import { Popover } from "../ui/popover.tsx";

export interface UnavailableExplanation {
    readonly title: string;
    readonly detail: string;
}

/**
 * An unavailable control the user cannot make available from here explains itself beside it when pressed, instead of
 * ignoring the press; a toast would cover the composer on a phone.
 */
export function ExplainedUnavailable({
    explanation,
    children,
}: {
    readonly explanation: UnavailableExplanation;
    readonly children: ReactElement;
}) {
    return (
        <Popover.Root>
            <Popover.Trigger asChild>{children}</Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    align="end"
                    aria-label={explanation.title}
                    className={cn(
                        "z-50 w-[min(calc(100vw-1.5rem),300px)] animate-cloud-enter px-3.5 py-3 text-xs leading-5 text-muted-foreground outline-none motion-reduce:animate-none",
                        overlaySurfacePanelClassName,
                        overlaySurfaceRadiusClassName,
                    )}
                    collisionPadding={12}
                    role="dialog"
                    side="top"
                >
                    <p className="font-medium text-foreground">{explanation.title}</p>
                    <p className="mt-1">{explanation.detail}</p>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}
