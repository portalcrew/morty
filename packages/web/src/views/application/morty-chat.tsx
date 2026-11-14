import { useStore } from "zustand";
import type { MortyApplication } from "../../view-models/morty-application.ts";
import { BotChatHome } from "../chat/bot-chat-home.tsx";

/**
 * The signed-in application surface. The application builds the workspace for
 * the active identity outside React; this view subscribes to that surface and
 * flows the workspace into the chat views through props.
 */
export function MortyChat({ application }: { readonly application: MortyApplication }) {
    const { workspace } = useStore(application.sessionWorkspace);
    if (workspace === null) {
        return <section className="flex min-h-dvh" />;
    }
    return <BotChatHome workspace={workspace} />;
}
