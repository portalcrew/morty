import type { ReactNode } from "react";
import { useDesktopChatLayout } from "./use-desktop-chat-layout.ts";

export function DesktopChatLayout({ children }: { readonly children: (desktop: boolean) => ReactNode }) {
    return children(useDesktopChatLayout());
}
