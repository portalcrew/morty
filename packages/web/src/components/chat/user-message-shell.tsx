import type { ReactNode } from "react";

export function UserMessageShell({ children }: { readonly children: ReactNode }) {
    return (
        <div className="flex min-w-0 justify-end">
            <div className="grid min-w-0 max-w-[85%] gap-2 max-md:max-w-[94%]">{children}</div>
        </div>
    );
}
