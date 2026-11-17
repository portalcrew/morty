import { type ComponentProps, useCallback } from "react";

/** Keep the fixed chat pane inside the visible viewport when a phone keyboard covers its bottom edge. */
export function ChatVisibleViewport(props: Omit<ComponentProps<"main">, "ref">) {
    const attach = useCallback((root: HTMLElement | null) => {
        const view = root?.ownerDocument.defaultView;
        if (root === null || view === null || view === undefined) {
            return;
        }
        const visible = view.visualViewport;
        const mobile = view.matchMedia("(max-width: 639px)");
        const sync = () => {
            if (!mobile.matches || !visible) {
                root.style.removeProperty("top");
                root.style.removeProperty("bottom");
                return;
            }
            const top = Math.max(0, visible.offsetTop);
            root.style.top = `${top}px`;
            root.style.bottom = `${Math.max(0, view.innerHeight - visible.height - top)}px`;
        };
        mobile.addEventListener("change", sync);
        view.addEventListener("resize", sync);
        visible?.addEventListener("resize", sync);
        visible?.addEventListener("scroll", sync);
        sync();
        return () => {
            mobile.removeEventListener("change", sync);
            view.removeEventListener("resize", sync);
            visible?.removeEventListener("resize", sync);
            visible?.removeEventListener("scroll", sync);
            root.style.removeProperty("top");
            root.style.removeProperty("bottom");
        };
    }, []);

    return <main {...props} ref={attach} />;
}
