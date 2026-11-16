import type { NativeSessionTarget } from "@portalcrew/morty-client/protocol";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { ComposerAttachment } from "../../components/chat/composer-attachment.ts";
import {
    agentQuestionChoicesEntry,
    centralSessionStorage,
    sessionDraftEntry,
} from "../../services/session-storage/central-session-storage.ts";
import type { AgentQuestionChoices } from "./agent-question-answer.ts";
import { type ComposerAttachmentStore, createComposerAttachmentStore } from "./composer-attachment-store.ts";
import { returnToComposer } from "./composer-return.ts";
import { prependToDraft } from "./session-delivery-store.ts";

/**
 * What the user is writing to a Session on this page: the composer's text and files, the title being edited and the
 * answers picked for the Agent's questions. It belongs to the Session, not to the pane showing it, so replacing the
 * pane on a re-read or reconnection changes none of it.
 */
export interface SessionComposerStore {
    readonly draft: string;
    readonly attachments: StoreApi<ComposerAttachmentStore>;
    readonly filesRestoreNotice: boolean;
    readonly titleDraft: string | null;
    readonly answerChoices: ReadonlyMap<string, AgentQuestionChoices>;
    readonly setDraft: (draft: string) => void;
    readonly sent: () => void;
    /**
     * Returns a message the user takes back for editing to the composer, ahead of what was written since.
     * `filesLost` says whether files it had could not be restored here.
     */
    readonly returnMessage: (content: string, filesLost: boolean, restored: readonly ComposerAttachment[]) => void;
    readonly adoptHandoff: (draft: string, attachments: StoreApi<ComposerAttachmentStore>) => void;
    readonly openTitleEdit: (title: string) => void;
    readonly setTitleDraft: (draft: string) => void;
    readonly closeTitleEdit: () => void;
    readonly chooseAnswer: (
        openMessageIds: ReadonlySet<string>,
        messageId: string,
        questionIndex: number,
        answer: string,
    ) => void;
    readonly questionsClosed: () => void;
}

/**
 * The Session's composer, persisted for the next page where it is today: the draft and the picked answers. A message an
 * earlier page left unsent comes back ahead of the draft, never delivered implicitly.
 */
export function createSessionComposerStore(
    computerId: string,
    sessionTarget: NativeSessionTarget,
    unsent: string | null,
) {
    const draftEntry = sessionDraftEntry(computerId, sessionTarget);
    const answerChoicesEntry = agentQuestionChoicesEntry(computerId, sessionTarget);
    const saveDraft = (draft: string): void => {
        if (draft === "") {
            centralSessionStorage.remove(draftEntry);
        } else {
            centralSessionStorage.write(draftEntry, draft);
        }
    };
    const stored = centralSessionStorage.read(draftEntry) ?? "";
    const initialDraft = unsent === null ? stored : prependToDraft(unsent, stored);
    saveDraft(initialDraft);
    return createStore<SessionComposerStore>()((set, get) => {
        const setDraft = (draft: string, filesRestoreNotice: boolean): void => {
            saveDraft(draft);
            set({ draft, filesRestoreNotice: draft !== "" && filesRestoreNotice });
        };
        return {
            draft: initialDraft,
            attachments: createComposerAttachmentStore(),
            filesRestoreNotice: false,
            titleDraft: null,
            answerChoices: new Map(Object.entries(centralSessionStorage.read(answerChoicesEntry) ?? {})),
            setDraft: (draft) => setDraft(draft, get().filesRestoreNotice),
            sent: () => {
                get().attachments.getState().clear();
                setDraft("", false);
            },
            returnMessage: (content, filesLost, restored) => {
                const current = get();
                const files = current.attachments.getState();
                const returned = returnToComposer(current.draft, files.attachments, content, restored);
                if (restored.length > 0) {
                    files.restore(returned.attachments);
                }
                setDraft(returned.draft, filesLost);
            },
            adoptHandoff: (draft, attachments) => {
                saveDraft(draft);
                set({ draft, attachments, filesRestoreNotice: false });
            },
            openTitleEdit: (title) => set({ titleDraft: title }),
            setTitleDraft: (draft) => {
                if (get().titleDraft !== null) {
                    set({ titleDraft: draft });
                }
            },
            closeTitleEdit: () => set({ titleDraft: null }),
            chooseAnswer: (openMessageIds, messageId, questionIndex, answer) => {
                if (!openMessageIds.has(messageId)) {
                    return;
                }
                const choices = new Map([...get().answerChoices].filter(([id]) => openMessageIds.has(id)));
                choices.set(messageId, { ...choices.get(messageId), [questionIndex.toString()]: answer });
                centralSessionStorage.write(answerChoicesEntry, Object.fromEntries(choices));
                set({ answerChoices: choices });
            },
            questionsClosed: () => {
                centralSessionStorage.remove(answerChoicesEntry);
                set({ answerChoices: new Map() });
            },
        };
    });
}
