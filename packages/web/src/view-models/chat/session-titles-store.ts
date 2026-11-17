import { NativeSessionMap, sameNativeSession } from "@portalcrew/morty-client/native-session";
import type { NativeSessionTarget } from "@portalcrew/morty-client/protocol";
import { createStore } from "zustand/vanilla";
import type { ManagedChatSession } from "../../services/chat/bot-chat-api.ts";
import {
    centralSessionStorage,
    rememberedSessionEntry,
} from "../../services/session-storage/central-session-storage.ts";

type SessionTitle = {
    readonly kind: "known" | "created";
    readonly title: string;
    /** When its source was observed or its read started, in this page's read order. */
    readonly since: number;
};

export type SessionTitles = Pick<NativeSessionMap<SessionTitle>, "get" | "has" | typeof Symbol.iterator>;
export type SessionTitlesStore = Omit<ReturnType<typeof createSessionTitlesStore>, "setState">;

export function sessionTitle(
    titles: SessionTitles,
    sessionTarget: NativeSessionTarget | null,
    fallback = "Untitled session",
): string {
    return (sessionTarget === null ? undefined : titles.get(sessionTarget)?.title) ?? fallback;
}

/**
 * One display title per Session. The Computer is authoritative; a read's answer replaces a title only when the read
 * started after that title's source, so neither an in-flight read nor a slower older one undoes newer knowledge.
 */
export function createSessionTitlesStore(identityKey: string | null) {
    let rememberedId: NativeSessionTarget | null = null;
    let order = 0;
    return createStore<{
        readonly titles: SessionTitles;
        readonly restore: () => void;
        readonly remember: (sessionTarget: NativeSessionTarget) => void;
        readonly forget: (sessionTarget: NativeSessionTarget) => void;
        readonly observed: (sessionTarget: NativeSessionTarget, title: string) => void;
        readonly created: (sessionTarget: NativeSessionTarget, title: string) => void;
        /** Marks the start of a read whose answer `sessionLoaded` or `directoryLoaded` receives. */
        readonly readStarted: () => number;
        readonly sessionLoaded: (sessionTarget: NativeSessionTarget, title: string, startedAt: number) => void;
        readonly directoryLoaded: (sessions: readonly ManagedChatSession[], startedAt: number) => void;
    }>()((set, get) => {
        const persist = (): void => {
            if (identityKey === null || rememberedId === null) {
                return;
            }
            const title = get().titles.get(rememberedId)?.title;
            if (title !== undefined && title.length > 0) {
                centralSessionStorage.write(rememberedSessionEntry(identityKey), { target: rememberedId, title });
            }
        };
        const put = (sessionTarget: NativeSessionTarget, value: SessionTitle): void => {
            set((state) => ({ titles: new NativeSessionMap(state.titles).set(sessionTarget, value) }));
            if (rememberedId !== null && sameNativeSession(rememberedId, sessionTarget)) {
                persist();
            }
        };
        return {
            titles: new NativeSessionMap(),
            restore: () => {
                if (identityKey === null || rememberedId !== null) {
                    return;
                }
                const saved = centralSessionStorage.read(rememberedSessionEntry(identityKey));
                if (saved !== null) {
                    rememberedId = saved.target;
                    if (!get().titles.has(saved.target)) {
                        set((state) => ({
                            titles: new NativeSessionMap(state.titles).set(saved.target, {
                                kind: "known",
                                title: saved.title,
                                since: 0,
                            }),
                        }));
                    }
                }
            },
            remember: (sessionTarget) => {
                rememberedId = sessionTarget;
                persist();
            },
            forget: (sessionTarget) => {
                if (rememberedId !== null && sameNativeSession(rememberedId, sessionTarget)) {
                    rememberedId = null;
                    if (identityKey !== null) {
                        centralSessionStorage.remove(rememberedSessionEntry(identityKey));
                    }
                }
                set((state) => {
                    const titles = new NativeSessionMap(state.titles);
                    titles.delete(sessionTarget);
                    return { titles };
                });
            },
            observed: (sessionTarget, title) => put(sessionTarget, { kind: "known", title, since: ++order }),
            created: (sessionTarget, title) => put(sessionTarget, { kind: "created", title, since: ++order }),
            readStarted: () => ++order,
            sessionLoaded: (sessionTarget, title, startedAt) => {
                const current = get().titles.get(sessionTarget);
                if (current?.kind === "created" || (current !== undefined && current.since > startedAt)) {
                    return;
                }
                put(sessionTarget, { kind: "known", title, since: startedAt });
            },
            directoryLoaded: (sessions, startedAt) => {
                const titles = new NativeSessionMap(get().titles);
                for (const session of sessions) {
                    const current = titles.get(session.target);
                    if (
                        (current?.kind === "created" && !session.prompted) ||
                        (current !== undefined && current.since > startedAt)
                    ) {
                        continue;
                    }
                    titles.set(session.target, { kind: "known", title: session.title, since: startedAt });
                }
                set({ titles });
                persist();
            },
        };
    });
}
