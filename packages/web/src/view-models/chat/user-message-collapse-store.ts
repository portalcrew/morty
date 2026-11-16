import { createStore } from "zustand/vanilla";

export interface UserMessageCollapseState {
    readonly expandedIds: ReadonlySet<string>;
    readonly toggle: (messageId: string) => void;
}

/** One session's disclosure choices, retained while individual messages mount and unmount. */
export function createUserMessageCollapseStore() {
    return createStore<UserMessageCollapseState>()((set) => ({
        expandedIds: new Set<string>(),
        toggle: (messageId) =>
            set((state) => {
                const expandedIds = new Set(state.expandedIds);
                if (expandedIds.has(messageId)) {
                    expandedIds.delete(messageId);
                } else {
                    expandedIds.add(messageId);
                }
                return { expandedIds };
            }),
    }));
}

export type UserMessageCollapseStore = ReturnType<typeof createUserMessageCollapseStore>;
