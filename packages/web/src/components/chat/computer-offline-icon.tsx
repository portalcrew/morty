import { CloudOff } from "lucide-react";
import { cn } from "../../lib/utils.ts";

export function ComputerOfflineIcon({ small = false }: { readonly small?: boolean }) {
    return (
        <span
            className={cn(
                "flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
                small ? "size-9" : "size-11",
            )}
        >
            <CloudOff aria-hidden="true" className={small ? "size-4" : "size-5"} />
        </span>
    );
}
