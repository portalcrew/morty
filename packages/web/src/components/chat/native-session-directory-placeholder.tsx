import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils.ts";

export function NativeSessionDirectoryPlaceholder({
    icon: Icon,
    title,
    description,
    action,
    tone = "muted",
}: {
    readonly icon: LucideIcon;
    readonly title: string;
    readonly description?: ReactNode;
    readonly action?: ReactNode;
    readonly tone?: "muted" | "destructive";
}) {
    return (
        <div
            className="flex min-h-0 flex-1 flex-col items-center justify-center px-2.5 text-center text-13"
            {...(tone === "destructive" ? { role: "alert" as const } : {})}
        >
            <div className="flex flex-col items-center gap-2.5 py-6">
                <span
                    className={cn(
                        "flex size-10 items-center justify-center rounded-full",
                        tone === "destructive" ? "bg-destructive/10" : "bg-morty-fill-opacity-2",
                    )}
                >
                    <Icon
                        aria-hidden="true"
                        className={cn("size-4.5", tone === "destructive" ? "text-destructive" : "text-morty-text-3")}
                    />
                </span>
                <div className="flex max-w-[14rem] flex-col gap-1">
                    <p
                        className={cn(
                            "font-medium leading-snug",
                            tone === "destructive" ? "text-destructive" : "text-secondary-foreground",
                        )}
                    >
                        {title}
                    </p>
                    {description !== undefined && (
                        <p
                            className={cn(
                                "leading-snug",
                                tone === "destructive" ? "text-destructive/80" : "text-morty-text-3",
                            )}
                        >
                            {description}
                        </p>
                    )}
                </div>
                {action}
            </div>
        </div>
    );
}
