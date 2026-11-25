import { createStore } from "zustand/vanilla";
import type { ComposerAttachment } from "../../components/chat/composer-attachment.ts";
import { AttachmentReadError, readPromptAttachment } from "./attachment-reader.ts";

type AttachmentReadState =
    | { readonly kind: "idle" }
    | { readonly kind: "reading" }
    | { readonly kind: "failed"; readonly message: string };

export interface ComposerAttachmentStore {
    readonly attachments: readonly ComposerAttachment[];
    readonly state: AttachmentReadState;
    readonly addFiles: (files: readonly File[], signal: AbortSignal) => void;
    readonly remove: (index: number) => void;
    readonly clear: () => void;
    readonly restore: (attachments: readonly ComposerAttachment[]) => void;
}

const ATTACHMENT_LIMIT = 8;

export function canAddAttachments(model: ComposerAttachmentStore): boolean {
    return model.state.kind !== "reading" && model.attachments.length < ATTACHMENT_LIMIT;
}

// One at a time: a resized photo is decoded at full size, and several at once can exhaust a phone's page memory.
async function readAttachments(files: readonly File[], signal: AbortSignal): Promise<readonly ComposerAttachment[]> {
    const read: ComposerAttachment[] = [];
    for (const file of files) {
        read.push(await readPromptAttachment(file, signal));
    }
    return read;
}

export function createComposerAttachmentStore(initial: readonly ComposerAttachment[] = []) {
    let pending: AbortController | null = null;
    return createStore<ComposerAttachmentStore>()((set, get) => ({
        attachments: initial,
        state: { kind: "idle" },
        addFiles: (files, signal) => {
            if (signal.aborted || !canAddAttachments(get()) || files.length === 0) {
                return;
            }
            const controller = new AbortController();
            pending = controller;
            const readSignal = AbortSignal.any([signal, controller.signal]);
            set({ state: { kind: "reading" } });
            void readAttachments(files.slice(0, ATTACHMENT_LIMIT - get().attachments.length), readSignal).then(
                (read) => {
                    if (readSignal.aborted || pending !== controller) {
                        return;
                    }
                    const added: readonly ComposerAttachment[] = read;
                    pending = null;
                    // Read the latest list: a removal during file I/O must survive completion.
                    set((current) => ({ attachments: [...current.attachments, ...added], state: { kind: "idle" } }));
                },
                (cause: unknown) => {
                    if (pending !== controller) {
                        return;
                    }
                    pending = null;
                    if (readSignal.aborted) {
                        return;
                    }
                    controller.abort(cause);
                    set({
                        state: {
                            kind: "failed",
                            message:
                                cause instanceof AttachmentReadError
                                    ? cause.message
                                    : "The selected attachment could not be read.",
                        },
                    });
                },
            );
        },
        remove: (index) => set((current) => ({ attachments: current.attachments.filter((_, item) => item !== index) })),
        clear: () => {
            const previous = pending;
            pending = null;
            previous?.abort(new DOMException("The attachment draft was cleared.", "AbortError"));
            set({ attachments: [], state: { kind: "idle" } });
        },
        restore: (attachments) => {
            get().clear();
            set({ attachments });
        },
    }));
}
