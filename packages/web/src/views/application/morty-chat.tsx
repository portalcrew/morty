import { useStore } from "zustand";
import type { MortyApplication } from "../../view-models/morty-application.ts";
import { BotChatHome } from "../chat/bot-chat-home.tsx";

export function MortyChat({ application }: { readonly application: MortyApplication }) {
    const { workspace } = useStore(application.sessionWorkspace);
    if (workspace === null) {
        return <section className="flex min-h-dvh" />;
    }
    return <BotChatHome workspace={workspace} />;
}
