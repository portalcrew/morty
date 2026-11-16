import type { NativeSessionEntry, NativeSessionTarget, SessionReadyBody } from "@portalcrew/morty-client/protocol";
import type { ChatAccess } from "../../services/chat/bot-chat-api.ts";

export interface OpenMortySession {
    readonly target: NativeSessionTarget;
    /** The request that opened it, which a bug report cites for the settings it read. */
    readonly requestId: string;
    readonly ready: SessionReadyBody;
    readonly entry: SessionEntry;
    readonly origin:
        | { readonly kind: "opened" }
        /** The page just created it, so it holds the Session credential. */
        | { readonly kind: "created"; readonly access: ChatAccess };
}

type SessionEntry = Omit<NativeSessionEntry, "sessionId">;

export type SelectedMortySession = Omit<OpenMortySession, "entry"> & {
    readonly entry: Omit<SessionEntry, "title">;
};

export function selectedSession(session: OpenMortySession): SelectedMortySession {
    const { title: _title, ...entry } = session.entry;
    return { ...session, entry };
}
