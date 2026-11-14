import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export function Spinner({ className = "", label }: { readonly className?: string; readonly label: string }) {
    return (
        <span
            role="status"
            aria-label={label}
            className={cn("inline-flex shrink-0 items-center justify-center text-muted-foreground", className)}
        >
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
        </span>
    );
}
