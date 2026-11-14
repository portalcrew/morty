import { type ReactNode, useMemo } from "react";

function mergeAttachHandlers(
    ...handlers: readonly ((node: HTMLElement | null) => (() => void) | undefined)[]
): (node: HTMLElement | null) => (() => void) | undefined {
    return (node) => {
        if (node === null) {
            return;
        }
        const cleanups = handlers
            .map((handler) => handler(node))
            .filter((cleanup): cleanup is () => void => cleanup !== undefined);
        return () => {
            for (const cleanup of cleanups) {
                cleanup();
            }
        };
    };
}

/** Hosts sidebar access notices and keeps their store attach lifetimes. */
export function SidebarAccessNoticeHost({
    attachAccess,
    attachLinkedDevices,
    children,
}: {
    readonly attachAccess: (node: HTMLElement | null) => (() => void) | undefined;
    readonly attachLinkedDevices: (node: HTMLElement | null) => (() => void) | undefined;
    readonly children: ReactNode;
}) {
    // The stores follow their data while the host is attached, so the ref must change only when they do: a ref created
    // per render would detach and reattach on every render and restart their reads each time.
    const attach = useMemo(
        () => mergeAttachHandlers(attachLinkedDevices, attachAccess),
        [attachAccess, attachLinkedDevices],
    );

    return (
        <div className="relative z-30 w-full min-w-0 shrink-0" ref={attach}>
            {children}
        </div>
    );
}
