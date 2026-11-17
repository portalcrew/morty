import {
    MortyApiError,
    MortyCancellationError,
    type MortyClient,
    MortyError,
    MortyOperationError,
    MortyValidationError,
} from "@portalcrew/morty-client";
import type { PromptAttachment } from "@portalcrew/morty-client/protocol";
import { createStore } from "zustand/vanilla";
import type { ComposerAttachment } from "../../components/chat/composer-attachment.ts";
import { SessionStorageWriteError } from "../../services/session-storage/central-session-storage.ts";
import { formatError } from "../format-error.ts";
import {
    commandAnswer,
    runtimeCoversMessage,
    runtimeHoldsCommand,
    type SessionExecutionState,
} from "./session-execution.ts";

type SubmitRequest = Parameters<MortyClient["turns"]["submit"]>[1];
export type SubmitTurn = (request: SubmitRequest, signal: AbortSignal) => Promise<void>;
interface DeliveryAttempt {
    readonly prepare: (message: SubmittedMessage, signal: AbortSignal) => Promise<Journal["request"]>;
    readonly submit: SubmitTurn;
}
/**
 * Where this page shows a message: as the Session's next turn, or in its queue. Until the Computer answers, sending
 * decides it from whether a turn runs; the answer then decides it. It never changes what is submitted: the Computer
 * alone admits a message, running it now or queueing it.
 */
export type DeliveryPlacement = "turn" | "queue";

/** A message the Computer accepted; where it shows follows from the Computer's answer about it. */
export interface AcceptedMessage {
    readonly attachments:
        | { readonly kind: "local"; readonly values: readonly ComposerAttachment[] }
        | { readonly kind: "uploaded"; readonly values: readonly PromptAttachment[] };
    readonly commandId: string;
    readonly content: string;
}

/** A message the Computer has not answered for, shown where the page expects it. */
export interface SubmittedMessage extends AcceptedMessage {
    readonly placement: DeliveryPlacement;
}
export type Journal = {
    readonly attachments: readonly ComposerAttachment[] | null;
    readonly commandId: string;
    readonly placement: DeliveryPlacement;
    /** Chat states the Session's whole binding, so a saved request stays complete for any Relay it is resent to. */
    readonly request: Omit<SubmitRequest, "idempotencyKey" | "disposition">;
};
function acceptedJournal(journal: Journal): AcceptedMessage {
    return {
        commandId: journal.commandId,
        content: journal.request.content,
        attachments:
            journal.attachments === null
                ? { kind: "uploaded", values: journal.request.attachments }
                : { kind: "local", values: journal.attachments },
    };
}

export function journalMessage(journal: Journal): SubmittedMessage {
    return { ...acceptedJournal(journal), placement: journal.placement };
}

export function deliveryMessagePresentation(message: AcceptedMessage) {
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
    /**
     * The user removed an unknown delivery, and the Computer is asked to withdraw it under its identity. Until the
     * Computer answers, the message may still run, so it keeps its record.
     */
    | { readonly kind: "withdrawing"; readonly journal: Journal }
    | { readonly kind: "failed"; readonly journal: Journal; readonly failure: SubmissionFailure };

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
        case "withdrawing":
            return null;
        default:
            return state satisfies never;
    }
}

/** A message the Computer may hold although this page has no confirmation of it. */
export function unconfirmedJournal(state: DeliveryState): Journal | null {
    return state.kind === "delivery-unknown" || state.kind === "withdrawing" ? state.journal : null;
}

export function awaitingMessage(state: DeliveryState): SubmittedMessage | null {
    return state.kind === "awaiting-connection" ? state.message : null;
}

/** The submitted intent and files have one owner through preparation, admission and queueing. */
export function deliveryMessages(delivery: DeliveryRecord): readonly AcceptedMessage[] {
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
        case "withdrawing":
        case "failed":
            return [...accepted, journalMessage(state.journal)];
        default:
            return state satisfies never;
    }
}

/**
 * What delivery recorded, not what the page shows: a delivery the Computer already holds is still unknown here, and
 * accepted messages the Computer's account covers still sit in the list. Read it through `settledDelivery`.
 */
export interface SessionDeliveryStore {
    readonly state: DeliveryState;
    readonly accepted: readonly AcceptedMessage[];
    /**
     * Withdraws the unknown delivery on the Computer, so it never runs. It is gone once `withdraw` says the Computer
     * withdrew it; otherwise it stays unknown, and a command the Computer already holds settles as the Computer's.
     */
    readonly withdrawUnknown: (withdraw: WithdrawCommand, signal: AbortSignal) => Promise<void>;
    readonly awaitConnection: (message: SubmittedMessage) => void;
    readonly takeFailedMessage: () => SubmittedMessage | null;
    readonly send: (message: SubmittedMessage, attempt: DeliveryAttempt) => Promise<void>;
    readonly retry: (submit: SubmitTurn) => Promise<void>;
}

/** Asks the Computer to withdraw a command before it starts; true when the Computer withdrew it. */
type WithdrawCommand = (commandId: string, signal: AbortSignal) => Promise<boolean>;

export type DeliveryRecord = Pick<SessionDeliveryStore, "state" | "accepted">;

/** Whether the Computer's answer leaves a message to show until its account shows it: it waits or runs. */
function awaitsAccount(runtime: SessionExecutionState, commandId: string): boolean {
    const answer = commandAnswer(runtime, commandId);
    switch (answer?.state) {
        case "preparing":
        case "queued":
        case "running":
            return true;
        case "settled":
        case "withdrawn":
        case "steered":
        case undefined:
            return false;
        default:
            return answer satisfies never;
    }
}

/**
 * Delivery as the Computer's account leaves it. An unknown delivery the Computer holds was delivered: it is idle, and
 * accepted while the Computer's answer says it waits or runs. An accepted message the Computer's account covers is
 * dropped, which releases the files the page kept for editing it; nothing reads them once the account shows the
 * message. A delivery being withdrawn waits for the answer to its withdrawal instead: the Computer also holds a command
 * it withdrew.
 */
export function settledDelivery(delivery: DeliveryRecord, runtime: SessionExecutionState): DeliveryRecord {
    const { state } = delivery;
    const settled: DeliveryRecord =
        state.kind === "delivery-unknown" && runtimeHoldsCommand(runtime, state.journal.commandId)
            ? {
                  state: { kind: "idle" },
                  accepted: awaitsAccount(runtime, state.journal.commandId)
                      ? [
                            ...delivery.accepted.filter((message) => message.commandId !== state.journal.commandId),
                            acceptedJournal(state.journal),
                        ]
                      : delivery.accepted,
              }
            : delivery;
    return {
        state: settled.state,
        accepted: settled.accepted.filter((message) => !runtimeCoversMessage(runtime, message.commandId)),
    };
}

function pendingSubmission(state: DeliveryState): {
    readonly commandId: string;
    readonly placement: DeliveryPlacement;
    readonly request: Journal["request"];
} | null {
    switch (state.kind) {
        case "submitting":
        case "delivery-unknown":
        case "withdrawing":
            return {
                commandId: state.journal.commandId,
                placement: state.journal.placement,
                request: state.journal.request,
            };
        case "idle":
        case "awaiting-connection":
        case "preparing":
        case "preparation-failed":
        case "failed":
            return null;
        default:
            return state satisfies never;
    }
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
        case "withdrawing":
            return null;
        default:
            return state satisfies never;
    }
}

export function prependToDraft(content: string, draft: string): string {
    return draft.length === 0 ? content : content.length === 0 ? draft : `${content}\n\n${draft}`;
}

/** A submission never left the browser, so the Computer cannot hold it. */
export class SubmissionNotSentError extends MortyError {
    constructor(options: ErrorOptions) {
        super("submission_not_sent", "The message could not be sent.", options);
        this.name = "SubmissionNotSentError";
    }
}

/** Local validation and the Computer's refusals settle delivery: nothing ran. Ambiguous failures do not. */
export function isAuthoritativeFailure(cause: unknown): boolean {
    return (
        cause instanceof SubmissionNotSentError ||
        cause instanceof MortyValidationError ||
        (cause instanceof MortyOperationError && cause.outcome === "refused") ||
        (cause instanceof MortyApiError && cause.status >= 400 && cause.status < 500)
    );
}

export const noSessionDelivery = createStore<Pick<SessionDeliveryStore, "state">>()(() => ({
    state: { kind: "idle" },
}));

export const createSessionDeliveryStore = (options: {
    readonly lifetime: AbortSignal;
    readonly pendingSubmission: Omit<Journal, "attachments"> | null;
    /** Writes the frozen request before it can leave the browser; failure prevents submission. */
    readonly pendingSubmissionChanged: (journal: Omit<Journal, "attachments"> | null) => void;
    readonly unsentMessageChanged: (content: string | null) => void;
    readonly runtime: () => SessionExecutionState;
}) => {
    const delivered = (journal: Journal): boolean => runtimeHoldsCommand(options.runtime(), journal.commandId);
    return createStore<SessionDeliveryStore>()((setState, get) => {
        // Each transition starts from the settled record, so it is where the files of covered messages are released and
        // where the saved request of a delivery the Computer holds is replaced. Until then the saved request stays: a
        // reload sends it again under the same identity, which the Computer holds already.
        const settled = (): DeliveryRecord => settledDelivery(get(), options.runtime());
        const set = (state: DeliveryState, accepted: readonly AcceptedMessage[] = settled().accepted): void => {
            const pending = pendingSubmission(state);
            if (pending?.commandId !== pendingSubmission(get().state)?.commandId) {
                options.pendingSubmissionChanged(pending);
            }
            options.unsentMessageChanged(unsentContent(state));
            setState({ state, accepted });
        };
        const confirm = (journal: Journal): void => {
            set({ kind: "idle" }, [
                ...settled().accepted.filter((message) => message.commandId !== journal.commandId),
                acceptedJournal(journal),
            ]);
        };
        const attempt = async (journal: Journal, submit: SubmitTurn, signal: AbortSignal): Promise<void> => {
            try {
                set({ kind: "submitting", journal });
            } catch (cause) {
                // The request could not be saved, so it cannot be recovered after a reload: it does not leave the browser.
                if (!(cause instanceof SessionStorageWriteError)) {
                    throw cause;
                }
                set({
                    kind: "preparation-failed",
                    message: journalMessage(journal),
                    failure: submissionFailure(cause, cause.message),
                });
                return;
            }
            try {
                await submit({ ...journal.request, idempotencyKey: journal.commandId }, signal);
                signal.throwIfAborted();
                confirm(journal);
            } catch (cause) {
                if (signal.aborted || cause instanceof MortyCancellationError) {
                    // The Session's lifetime on this page ended first. Losing the attempt's connection does not discard
                    // its submitted intent: what the service confirmed stays, the rest is unknown for the next page.
                    if (get().state.kind === "submitting") {
                        set({ kind: "delivery-unknown", journal });
                    }
                    throw cause;
                }
                if (isAuthoritativeFailure(cause)) {
                    set({
                        kind: "failed",
                        journal,
                        failure: submissionFailure(cause, "The message was rejected."),
                    });
                    return;
                }
                // A command the Computer already started will not run again: it holds the message, whatever the page saw.
                const applied = cause instanceof MortyOperationError && cause.outcome === "applied";
                if (get().state.kind === "submitting" && (applied || delivered(journal))) {
                    confirm(journal);
                    return;
                }
                set({ kind: "delivery-unknown", journal });
            }
        };
        return {
            state:
                options.pendingSubmission === null
                    ? { kind: "idle" }
                    : { kind: "delivery-unknown", journal: { ...options.pendingSubmission, attachments: null } },
            accepted: [],
            withdrawUnknown: async (withdraw, signal) => {
                const { state } = settled();
                if (state.kind !== "delivery-unknown") {
                    return;
                }
                const { journal } = state;
                set({ kind: "withdrawing", journal });
                let withdrawn = false;
                try {
                    withdrawn = await withdraw(journal.commandId, signal);
                } finally {
                    if (get().state.kind === "withdrawing") {
                        set(withdrawn ? { kind: "idle" } : { kind: "delivery-unknown", journal });
                    }
                }
            },
            awaitConnection: (message) => set({ kind: "awaiting-connection", message }),
            takeFailedMessage: () => {
                const failed = failedSubmission(get().state);
                if (failed !== null) {
                    set({ kind: "idle" });
                }
                return failed?.message ?? null;
            },
            send: async (message, delivery) => {
                const signal = options.lifetime;
                set({ kind: "preparing", message });
                let request: Journal["request"];
                try {
                    request = await delivery.prepare(message, signal);
                    signal.throwIfAborted();
                } catch (cause) {
                    signal.throwIfAborted();
                    set({
                        kind: "preparation-failed",
                        message,
                        failure: submissionFailure(cause, "The agent could not complete the message."),
                    });
                    return;
                }
                await attempt(
                    {
                        commandId: message.commandId,
                        placement: message.placement,
                        request,
                        attachments: message.attachments.kind === "local" ? message.attachments.values : null,
                    },
                    delivery.submit,
                    signal,
                );
            },
            // Only an unknown delivery repeats its identity; the Computer never runs a rejected command identity again.
            retry: async (submit) => {
                const { state } = settled();
                if (state.kind === "delivery-unknown") {
                    await attempt(state.journal, submit, options.lifetime);
                }
            },
        };
    });
};
