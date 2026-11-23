import type { ReactNode } from "react";
import { useToast } from "../ui/toast.tsx";

export interface ActionExplanation {
    readonly title: string;
    readonly description?: string;
}

export function QueueAction({
    label,
    disabled,
    explanation,
    onClick,
    children,
}: {
    readonly children: ReactNode;
    readonly disabled: boolean;
    /** Why the action is unavailable, for a reason the user cannot fix here: they can still reach it and learn why. */
    readonly explanation?: ActionExplanation | undefined;
    readonly label: string;
    readonly onClick: () => void;
}) {
    const showToast = useToast();
    const explained = disabled && explanation !== undefined;
    return (
        <button
            aria-disabled={explained || undefined}
            aria-label={label}
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-morty-text-3 outline-none transition-colors hover:bg-transparent hover:text-foreground keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:opacity-40"
            disabled={disabled && !explained}
            onClick={
                explanation !== undefined && explained ? () => showToast({ ...explanation, variant: "error" }) : onClick
            }
            title={explained ? explanation.title : label}
            type="button"
        >
            {children}
        </button>
    );
}
