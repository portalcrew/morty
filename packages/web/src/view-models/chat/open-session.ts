import type { NativeSessionEntry, NativeSessionTarget, SessionReadyBody } from "@morty-build/client/protocol";
import type { ChatAccess, ConversationActiveTurn } from "../../services/chat/bot-chat-api.ts";

/**
 * A Session the page has open. `target` is its identity, stated once: everything else describes that Session.
 * `origin` is how the page came to open it.
 */
export interface OpenMortySession {
    readonly target: NativeSessionTarget;
    /** The request that opened it, which a bug report cites for the settings it read. */
    readonly requestId: string;
    readonly ready: SessionReadyBody;
    readonly entry: SessionEntry;
    readonly origin:
        | { readonly kind: "opened" }
        /** The page just created it, so it holds the Session credential and the turn the Computer is running. */
        | {
              readonly kind: "created";
              readonly access: ChatAccess;
              readonly activeTurn: ConversationActiveTurn;
          };
}

/** What the page shows of a Session beyond its identity. */
type SessionEntry = Omit<NativeSessionEntry, "sessionId">;

/** The selected Session retains its connection metadata; its display title belongs to the title store. */
export type SelectedMortySession = Omit<OpenMortySession, "entry"> & {
    readonly entry: Omit<SessionEntry, "title">;
};

export function selectedSession(session: OpenMortySession): SelectedMortySession {
    const { title: _title, ...entry } = session.entry;
    return { ...session, entry };
}
