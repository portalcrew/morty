import {
    MortyApiError,
    MortyCancellationError,
    type MortyClient,
    MortyError,
    MortyOperationError,
    MortyValidationError,
} from "@morty-build/client";
import type { PromptAttachment } from "@morty-build/client/protocol";
import { createStore } from "zustand/vanilla";
import type { ComposerAttachment } from "../../components/chat/composer-attachment.ts";
import { CloudApiError } from "../../services/management/management-api.ts";
import { formatError } from "../format-error.ts";
import { runtimeCoversMessage, runtimeHoldsCommand, type SessionExecutionState } from "./session-execution.ts";

type SubmitRequest = Parameters<MortyClient["turns"]["submit"]>[1];
/** The service took the message: it runs now, or the Computer queued it behind the Session's earlier work. */
type AcceptedTurn = { readonly turnId: string; readonly queued: boolean };
export type SubmitTurn = (request: SubmitRequest, signal: AbortSignal) => Promise<AcceptedTurn>;
/**
 * How one attempt reaches the Session through the request access it started with. Preparation uploads the message's
 * files and freezes the request that delivery then owns through submission and recovery.
 */
interface DeliveryAttempt {
    readonly prepare: (message: SubmittedMessage, signal: AbortSignal) => Promise<Journal["request"]>;
    readonly submit: SubmitTurn;
}
type SubmissionOutcome =
    | { readonly kind: "accepted"; readonly turn: AcceptedTurn }
    /** The request failed, but the service had already shown it has the command. */
    | { readonly kind: "delivered" }
    | { readonly kind: "rejected" }
    | { readonly kind: "delivery-unknown" };
/**
 * Where this page shows a message: as the Session's next turn, or in its queue. Sending decides it from whether a
 * turn runs; once the service answers, the Computer's admission decides it. It never changes what is submitted: the
 * Computer alone admits a message, running it now or queueing it.
 */
export type DeliveryPlacement = "turn" | "queue";

export interface SubmittedMessage {
    readonly placement: DeliveryPlacement;
    readonly attachments:
        | { readonly kind: "local"; readonly values: readonly ComposerAttachment[] }
        | { readonly kind: "uploaded"; readonly values: readonly PromptAttachment[] };
    readonly commandId: string;
    readonly content: string;
}
export type Journal = {
    /** Original local files are kept only in memory; the request already owns uploaded references. */
    readonly attachments: readonly ComposerAttachment[] | null;
    readonly commandId: string;
    readonly placement: DeliveryPlacement;
    /** Chat states the Session's whole binding, so a saved request stays complete for any Relay it is resent to. */
    readonly request: Omit<SubmitRequest, "idempotencyKey" | "disposition">;
};
export function journalMessage(journal: Journal): SubmittedMessage {
    return {
        commandId: journal.commandId,
        content: journal.request.content,
        attachments:
            journal.attachments === null
                ? { kind: "uploaded", values: journal.request.attachments }
                : { kind: "local", values: journal.attachments },
        placement: journal.placement,
    };
}

export function deliveryMessagePresentation(message: SubmittedMessage) {
    return {
        ...message,
        displayPrompt:
            message.content.trim() || message.attachments.values.map((attachment) => attachment.name).join(", "),
        attachments: message.attachments.kind === "local" ? message.attachments.values : [],
        attachmentLabels:
            message.attachments.kind === "uploaded"
                ? message.attachments.values.map((attachment) => ({ name: attachment.name, uri: attachment.uri }))
                : [],
    };
}

/** Why a submission failed before the service accepted it; delivery is the one record of it. */
export type SubmissionFailure = { readonly code: string; readonly message: string };

function submissionFailure(cause: unknown, fallback: string): SubmissionFailure {
    return { code: cause instanceof MortyError ? cause.code : "", message: formatError(cause, fallback) };
}

export type DeliveryState =
    | { readonly kind: "idle" }
    /**
     * A message the Session holds until a connected pane prepares it: a new Session's first message, which its
     * delivery owns from the Session's creation, so no moment leaves it without a record a reload can return.
     */
    | { readonly kind: "awaiting-connection"; readonly message: SubmittedMessage }
    | { readonly kind: "preparing"; readonly message: SubmittedMessage }
    | { readonly kind: "preparation-failed"; readonly message: SubmittedMessage; readonly failure: SubmissionFailure }
    | { readonly kind: "submitting"; readonly journal: Journal }
    | { readonly kind: "delivery-unknown"; readonly journal: Journal }
    | { readonly kind: "failed"; readonly journal: Journal; readonly failure: SubmissionFailure };

/** The message of a submission that failed before the service accepted it, kept until it is retried or discarded. */
function failedSubmission(
    state: DeliveryState,
): { readonly message: SubmittedMessage; readonly failure: SubmissionFailure } | null {
    switch (state.kind) {
        case "preparation-failed":
            return { message: state.message, failure: state.failure };
        case "failed":
            return { message: journalMessage(state.journal), failure: state.failure };
        case "idle":
        case "awaiting-connection":
        case "preparing":
        case "submitting":
        case "delivery-unknown":
            return null;
        default:
            return state satisfies never;
    }
}

/** The message the Session holds for its next connected pane to submit. */
export function awaitingMessage(state: DeliveryState): SubmittedMessage | null {
    return state.kind === "awaiting-connection" ? state.message : null;
}

/** The submitted intent and files have one owner through preparation, admission and queueing. */
export function deliveryMessages(
    delivery: Pick<SessionDeliveryStore, "state" | "accepted">,
): readonly SubmittedMessage[] {
    const accepted = delivery.accepted;
    const state = delivery.state;
    switch (state.kind) {
        case "idle":
            return accepted;
        case "awaiting-connection":
        case "preparing":
        case "preparation-failed":
            return [...accepted, state.message];
        case "submitting":
        case "delivery-unknown":
        case "failed":
            return [...accepted, journalMessage(state.journal)];
        default:
            return state satisfies never;
    }
}

export interface SessionDeliveryStore {
    readonly state: DeliveryState;
    /**
     * Messages the service accepted, with their files for editing, until the Computer's account covers them. Whether
     * the page shows one is the presentation's decision, from the Computer's account as it stands.
     */
    readonly accepted: readonly SubmittedMessage[];
    readonly discardUnknown: () => void;
    /** Takes a new Session's first message, which a pane submits once it connects. */
    readonly awaitConnection: (message: SubmittedMessage) => void;
    readonly takeFailedMessage: () => SubmittedMessage | null;
    /**
     * Follows the Computer's account of the Session's execution as it now stands: an unknown delivery the Computer holds
     * is delivered, and accepted messages its account now covers release their files.
     */
    readonly observe: () => void;
    /** The user withdrew an accepted message from the Computer's queue, which confirmed it. */
    readonly withdraw: (commandId: string) => void;
    /**
     * Prepares and submits a message on the Session's lifetime: the pane that started the attempt may stop before it
     * settles, and the next pane shows where it is. The message is `preparing` as soon as this is called.
     */
    readonly send: (message: SubmittedMessage, attempt: DeliveryAttempt) => Promise<void>;
    readonly retry: (submit: SubmitTurn) => Promise<SubmissionOutcome | null>;
}

/**
 * Text the Computer has not taken: a reload returns it to the composer. A message that may have been delivered is
 * not unsent, because sending it again under a new identity could run it twice.
 */
function unsentContent(state: DeliveryState): string | null {
    switch (state.kind) {
        case "awaiting-connection":
        case "preparing":
        case "preparation-failed":
            return state.message.content.trim() === "" ? null : state.message.content;
        case "failed":
            return state.journal.request.content === "" ? null : state.journal.request.content;
        case "idle":
        case "submitting":
        case "delivery-unknown":
            return null;
        default:
            return state satisfies never;
    }
}

/** Joins a message returned to the composer with the draft written after it. */
export function prependToDraft(content: string, draft: string): string {
    return draft.length === 0 ? content : content.length === 0 ? draft : `${content}\n\n${draft}`;
}

/** Local validation and terminal addressed refusals settle delivery; ambiguous or retryable failures do not. */
export function isAuthoritativeFailure(cause: unknown): boolean {
    return (
        cause instanceof MortyValidationError ||
        (cause instanceof MortyOperationError && cause.recovery === "terminal") ||
        (cause instanceof MortyApiError && cause.status >= 400 && cause.status < 500) ||
        (cause instanceof CloudApiError && cause.status !== null && cause.status >= 400 && cause.status < 500)
    );
}

/** The delivery of no Session, for a view that follows the open Session's delivery when none is open. */
export const noSessionDelivery = createStore<Pick<SessionDeliveryStore, "state">>()(() => ({
    state: { kind: "idle" },
}));

/** The Session owns delivery and runs each attempt on its own lifetime, apart from the pane that started it. */
export const createSessionDeliveryStore = (options: {
    /** The Session's lifetime on this page; only its end cancels an attempt. */
    readonly lifetime: AbortSignal;
    readonly pendingSubmission: Omit<Journal, "attachments"> | null;
    /** Writes the frozen request before it can leave the browser; failure prevents submission. */
    readonly pendingSubmissionChanged: (journal: Omit<Journal, "attachments"> | null) => void;
    /** Persists the unsent message's text, or clears it with null. */
    readonly unsentMessageChanged: (content: string | null) => void;
    /** The Computer's account of the Session's execution, as the page holds it now. */
    readonly runtime: () => SessionExecutionState;
}) => {
    type Update = {
        readonly state: DeliveryState;
        readonly accepted?: readonly SubmittedMessage[];
    };
    /**
     * The accepted messages the Computer's account does not cover yet. The presentation decides what the page shows;
     * dropping covered messages only releases their files, which nothing reads once the Computer's account shows them.
     */
    const uncovered = (accepted: readonly SubmittedMessage[]): readonly SubmittedMessage[] => {
        const runtime = options.runtime();
        return accepted.filter((message) => !runtimeCoversMessage(runtime, message));
    };
    /** The service accepted the journal's message, which the page keeps until the Computer's account covers it. */
    const accept = (journal: Journal, placement: DeliveryPlacement, current: SessionDeliveryStore): Update => ({
        state: { kind: "idle" },
        accepted: [
            ...current.accepted.filter((message) => message.commandId !== journal.commandId),
            { ...journalMessage(journal), placement },
        ],
    });
    const confirm = (
        journal: Journal,
        placement: DeliveryPlacement,
        set: (update: Update) => void,
        get: () => SessionDeliveryStore,
    ): void => {
        set(accept(journal, placement, get()));
    };
    /** Whether the Computer has shown it holds the submission whose request failed, which delivered it after all. */
    const delivered = (journal: Journal): boolean => runtimeHoldsCommand(options.runtime(), journal.commandId);
    const send = async (
        journal: Journal,
        submit: SubmitTurn,
        signal: AbortSignal,
        set: (state: Update) => void,
        get: () => SessionDeliveryStore,
    ): Promise<SubmissionOutcome> => {
        set({ state: { kind: "submitting", journal } });
        try {
            const accepted = await submit(
                {
                    ...journal.request,
                    idempotencyKey: journal.commandId,
                },
                signal,
            );
            signal.throwIfAborted();
            confirm(journal, accepted.queued ? "queue" : "turn", set, get);
            return { kind: "accepted", turn: accepted };
        } catch (cause) {
            if (signal.aborted || cause instanceof MortyCancellationError) {
                // The Session's lifetime on this page ended first. Losing the attempt's connection does not discard
                // its submitted intent: what the service confirmed stays, the rest is unknown for the next page.
                const state = get().state;
                if (state.kind === "submitting" && delivered(journal)) {
                    if (journal.placement === "queue") {
                        confirm(journal, journal.placement, set, get);
                    } else {
                        set({ state: { kind: "idle" } });
                    }
                } else if (state.kind === "submitting") {
                    set({ state: { kind: "delivery-unknown", journal } });
                }
                throw cause;
            }
            if (isAuthoritativeFailure(cause)) {
                set({
                    state: { kind: "failed", journal, failure: submissionFailure(cause, "The message was rejected.") },
                });
                return { kind: "rejected" };
            }
            const state = get().state;
            if (state.kind === "submitting" && delivered(journal)) {
                confirm(journal, journal.placement, set, get);
                return { kind: "delivered" };
            }
            set({ state: { kind: "delivery-unknown", journal } });
            return { kind: "delivery-unknown" };
        }
    };
    return createStore<SessionDeliveryStore>()((setState, get) => {
        const set = (update: Update): void => {
            const state = update.state;
            options.pendingSubmissionChanged(
                state.kind === "submitting" || state.kind === "delivery-unknown"
                    ? {
                          commandId: state.journal.commandId,
                          placement: state.journal.placement,
                          request: state.journal.request,
                      }
                    : null,
            );
            options.unsentMessageChanged(unsentContent(state));
            setState(update);
        };
        return {
            state:
                options.pendingSubmission === null
                    ? { kind: "idle" }
                    : { kind: "delivery-unknown", journal: { ...options.pendingSubmission, attachments: null } },
            accepted: [],
            discardUnknown: () => {
                if (get().state.kind === "delivery-unknown") {
                    set({ state: { kind: "idle" } });
                }
            },
            awaitConnection: (message) => set({ state: { kind: "awaiting-connection", message } }),
            takeFailedMessage: () => {
                const failed = failedSubmission(get().state);
                if (failed !== null) {
                    set({ state: { kind: "idle" } });
                }
                return failed?.message ?? null;
            },
            observe: () => {
                const current = get();
                const state = current.state;
                const confirmed: Update =
                    state.kind === "delivery-unknown" && delivered(state.journal)
                        ? // A recovered message to run is shown by the Computer's account; a queued one keeps its
                          // files for editing while it waits.
                          state.journal.placement === "queue"
                            ? accept(state.journal, state.journal.placement, current)
                            : { state: { kind: "idle" } }
                        : { state };
                const accepted = uncovered(confirmed.accepted ?? current.accepted);
                if (confirmed.state === state && accepted.length === current.accepted.length) {
                    return;
                }
                set({ ...confirmed, accepted });
            },
            withdraw: (commandId) => {
                setState({ accepted: get().accepted.filter((message) => message.commandId !== commandId) });
            },
            send: async (message, attempt) => {
                const signal = options.lifetime;
                set({ state: { kind: "preparing", message } });
                let request: Journal["request"];
                try {
                    request = await attempt.prepare(message, signal);
                    signal.throwIfAborted();
                } catch (cause) {
                    signal.throwIfAborted();
                    set({
                        state: {
                            kind: "preparation-failed",
                            message,
                            failure: submissionFailure(cause, "The agent could not complete the message."),
                        },
                    });
                    return;
                }
                // Freezing the request moves the message from unsent to possibly delivered under its identity.
                const journal: Journal = {
                    commandId: message.commandId,
                    placement: message.placement,
                    request,
                    attachments: message.attachments.kind === "local" ? message.attachments.values : null,
                };
                await send(journal, attempt.submit, signal, set, get);
            },
            // Only an unknown delivery repeats its identity; the Computer never runs a rejected command identity again.
            retry: async (submit) => {
                const state = get().state;
                return state.kind === "delivery-unknown"
                    ? await send(state.journal, submit, options.lifetime, set, get)
                    : null;
            },
        };
    });
};
