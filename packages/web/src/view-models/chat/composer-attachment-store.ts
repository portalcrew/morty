import { createStore } from "zustand/vanilla";
import type { ComposerAttachment } from "../../components/chat/composer-attachment.ts";
import { AttachmentReadError, type AttachmentReadErrorCode, readPromptAttachment } from "./attachment-reader.ts";

export type AttachmentRejection =
    | { readonly name: string; readonly reason: AttachmentReadErrorCode }
    | { readonly name: string; readonly reason: "attachment_limit"; readonly limit: number };

type AttachmentReadState =
    | { readonly kind: "idle" }
    | { readonly kind: "reading" }
    | { readonly kind: "rejected"; readonly rejections: readonly AttachmentRejection[] };

const IDLE: AttachmentReadState = { kind: "idle" };

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
async function readAttachments(
    files: readonly File[],
    signal: AbortSignal,
): Promise<{ readonly added: readonly ComposerAttachment[]; readonly rejected: readonly AttachmentRejection[] }> {
    const added: ComposerAttachment[] = [];
    const rejected: AttachmentRejection[] = [];
    for (const file of files) {
        try {
            added.push(await readPromptAttachment(file, signal));
        } catch (cause) {
            signal.throwIfAborted();
            rejected.push({
                name: file.name,
                reason: cause instanceof AttachmentReadError ? cause.code : "attachment_read_failed",
            });
        }
    }
    return { added, rejected };
}

export function createComposerAttachmentStore(initial: readonly ComposerAttachment[] = []) {
    let pending: AbortController | null = null;
    return createStore<ComposerAttachmentStore>()((set, get) => ({
        attachments: initial,
        state: IDLE,
        addFiles: (files, signal) => {
            if (signal.aborted || !canAddAttachments(get()) || files.length === 0) {
                return;
            }
            const controller = new AbortController();
            pending = controller;
            const readSignal = AbortSignal.any([signal, controller.signal]);
            set({ state: { kind: "reading" } });
            const capacity = ATTACHMENT_LIMIT - get().attachments.length;
            const overflow = files.slice(capacity).map(
                (file): AttachmentRejection => ({
                    name: file.name,
                    reason: "attachment_limit",
                    limit: ATTACHMENT_LIMIT,
                }),
            );
            void readAttachments(files.slice(0, capacity), readSignal).then(
                ({ added, rejected }) => {
                    if (readSignal.aborted || pending !== controller) {
                        return;
                    }
                    pending = null;
                    const rejections = [...rejected, ...overflow];
                    // Read the latest list: a removal during file I/O must survive completion.
                    set((current) => ({
                        attachments: [...current.attachments, ...added],
                        state: rejections.length === 0 ? IDLE : { kind: "rejected", rejections },
                    }));
                },
                () => {
                    if (pending === controller) {
                        pending = null;
                    }
                },
            );
        },
        // Removing an attachment is the user acting on the draft, so an earlier rejection no longer describes it.
        remove: (index) =>
            set((current) => ({
                attachments: current.attachments.filter((_, item) => item !== index),
                state: current.state.kind === "rejected" ? IDLE : current.state,
            })),
        clear: () => {
            const previous = pending;
            pending = null;
            previous?.abort(new DOMException("The attachment draft was cleared.", "AbortError"));
            set({ attachments: [], state: IDLE });
        },
        restore: (attachments) => {
            get().clear();
            set({ attachments });
        },
    }));
}
