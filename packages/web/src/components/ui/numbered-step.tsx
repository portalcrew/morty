import type { ReactNode } from "react";

export function NumberedStep({
    number,
    title,
    children,
}: {
    readonly number: number;
    readonly title: string;
    readonly children?: ReactNode;
}) {
    return (
        <li className="flex gap-3">
            <span
                aria-hidden="true"
                className="flex size-6 shrink-0 items-center justify-center rounded-full bg-morty-fill-opacity-3 text-12 font-semibold text-foreground"
            >
                {number}
            </span>
            <div className="min-w-0 flex-1 space-y-2 pt-0.5">
                <p className="text-14 font-medium leading-5 text-foreground">{title}</p>
                {children}
            </div>
        </li>
    );
}
