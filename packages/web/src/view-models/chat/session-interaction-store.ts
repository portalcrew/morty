import type { SessionElicitationField } from "@morty-build/client/protocol";
import { createStore } from "zustand/vanilla";
import type { AgentDisplayContent } from "../../components/agents/display-content.ts";
import {
    type ElicitationFieldValue,
    elicitationFieldValue,
    encodeElicitationAnswers,
} from "../../services/chat/elicitation-form.ts";
import { formatError } from "../format-error.ts";
import type {
    ElicitationInteraction,
    ElicitationInteractionResponse,
    PermissionInteraction,
    PermissionInteractionResponse,
    SessionInteraction,
} from "./session-pane-types.ts";
import type { SessionMessage } from "./session-presentation.ts";

// What the user does with the Agent's requests: the answers typed into its questions and the responses in flight. The
// requests themselves, and how each was resolved, are the Session's execution state (`session-execution.ts`). A
// response belongs to the Session, so switching panes does not end it.

type InteractionOperation =
    | { readonly kind: "submitting" }
    | { readonly kind: "submitted" }
    | { readonly kind: "failed"; readonly message: string };

/** The answers typed so far into each pending question, by question and then by field. */
export type ElicitationAnswerDrafts = ReadonlyMap<string, Readonly<Record<string, ElicitationFieldValue>>>;

export interface SessionInteractionStore {
    /** What the user typed into questions not yet answered; it belongs to the Session, not to this pane. */
    readonly answerDrafts: ElicitationAnswerDrafts;
    readonly editAnswer: (interactionId: string, fieldName: string, value: ElicitationFieldValue) => void;
    readonly submissions: ReadonlyMap<string, InteractionOperation>;
    /** The questions the user tried to accept, so a required answer still missing is pointed out. */
    readonly acceptAttempts: ReadonlySet<string>;
    /**
     * The Computer's account now leaves `pending` the questions still waiting for an answer. Drafts last only while
     * their question is pending; an answered or withdrawn question drops its draft.
     */
    readonly questionsChanged: (pending: ReadonlySet<string>) => void;
    readonly respondToPermission: (response: PermissionInteractionResponse, signal: AbortSignal) => void;
    readonly respondToElicitation: (response: ElicitationInteractionResponse, signal: AbortSignal) => void;
    /** Accepts a form question with the answers typed so far, unless a required answer is still missing. */
    readonly acceptElicitation: (elicitation: FormElicitation, signal: AbortSignal) => void;
}

/** A question the Agent asks with fields to fill. */
export type FormElicitation = Extract<ElicitationInteraction, { readonly mode: "form" }>;

/**
 * The first required choice the answers leave empty. A select is not a native form control, so the form's own required
 * check never covers it.
 */
function missingRequiredChoice(
    fields: readonly SessionElicitationField[],
    answers: Readonly<Record<string, ElicitationFieldValue>>,
): SessionElicitationField | undefined {
    return fields.find(
        (field) => field.type === "select" && field.required && elicitationFieldValue(field, answers) === "",
    );
}

export function createSessionInteractionStore(ports: {
    readonly permission: (response: PermissionInteractionResponse, signal: AbortSignal) => Promise<void>;
    readonly elicitation: (response: ElicitationInteractionResponse, signal: AbortSignal) => Promise<void>;
    /** The answer drafts the Session kept, and where changes to them are kept. */
    readonly answerDrafts: ElicitationAnswerDrafts;
    readonly answerDraftsChanged: (drafts: ElicitationAnswerDrafts) => void;
}) {
    return createStore<SessionInteractionStore>()((set, get) => {
        const replaceAnswerDrafts = (drafts: ElicitationAnswerDrafts): void => {
            set({ answerDrafts: drafts });
            ports.answerDraftsChanged(drafts);
        };
        const record = (id: string, operation: InteractionOperation): void => {
            set((current) => ({ submissions: new Map(current.submissions).set(id, operation) }));
        };
        const submit = (id: string, signal: AbortSignal, respond: () => Promise<void>): void => {
            // The next interaction may arrive before the previous response is acknowledged.
            const operation = get().submissions.get(id);
            if (signal.aborted || operation?.kind === "submitting" || operation?.kind === "submitted") {
                return;
            }
            record(id, { kind: "submitting" });
            void respond().then(
                () => {
                    if (get().answerDrafts.has(id)) {
                        replaceAnswerDrafts(new Map([...get().answerDrafts].filter(([draftId]) => draftId !== id)));
                    }
                    if (!signal.aborted) {
                        record(id, { kind: "submitted" });
                    }
                },
                (cause: unknown) => {
                    if (signal.aborted) {
                        return;
                    }
                    record(id, {
                        kind: "failed",
                        message: formatError(cause, "The response could not be submitted."),
                    });
                },
            );
        };
        return {
            answerDrafts: ports.answerDrafts,
            editAnswer: (interactionId, fieldName, value) => {
                const current = get().answerDrafts;
                replaceAnswerDrafts(
                    new Map(current).set(interactionId, { ...(current.get(interactionId) ?? {}), [fieldName]: value }),
                );
            },
            submissions: new Map(),
            acceptAttempts: new Set(),
            questionsChanged: (pending) => {
                const drafts = get().answerDrafts;
                if ([...drafts.keys()].some((id) => !pending.has(id))) {
                    replaceAnswerDrafts(new Map([...drafts].filter(([id]) => pending.has(id))));
                }
                if ([...get().acceptAttempts].some((id) => !pending.has(id))) {
                    set((current) => ({
                        acceptAttempts: new Set([...current.acceptAttempts].filter((id) => pending.has(id))),
                    }));
                }
            },
            respondToPermission: (response, signal) =>
                submit(response.interactionId, signal, () => ports.permission(response, signal)),
            respondToElicitation: (response, signal) =>
                submit(response.interactionId, signal, () => ports.elicitation(response, signal)),
            acceptElicitation: (elicitation, signal) => {
                const answers = get().answerDrafts.get(elicitation.interactionId) ?? {};
                if (missingRequiredChoice(elicitation.fields, answers) !== undefined) {
                    set((current) => ({
                        acceptAttempts: new Set(current.acceptAttempts).add(elicitation.interactionId),
                    }));
                    return;
                }
                submit(elicitation.interactionId, signal, () =>
                    ports.elicitation(
                        {
                            answer: {
                                action: "accept",
                                content: encodeElicitationAnswers(elicitation.fields, answers),
                            },
                            interactionId: elicitation.interactionId,
                            target: elicitation.target,
                        },
                        signal,
                    ),
                );
            },
        };
    });
}

export type PermissionFileChange = Extract<AgentDisplayContent, { readonly type: "diff" }>;

/**
 * The diffs of the tool call a permission asks about. A request names its tool call and may omit
 * what the Agent already announced for it, so the timeline's merged call is the one that carries them.
 */
function requestedFileChanges(
    messages: readonly SessionMessage[],
    toolCallId: string,
): readonly PermissionFileChange[] {
    const announced = messages
        .flatMap((message) =>
            message.role === "assistant" &&
            message.presentation.kind === "tool" &&
            message.presentation.entry.id === toolCallId
                ? [message.presentation.entry]
                : [],
        )
        .at(-1);
    return announced?.content.flatMap((content) => (content.type === "diff" ? [content] : [])) ?? [];
}

/** What the interaction cards show of the Agent's pending `interactions` and the user's responses to them. */
export function sessionInteractionPresentation(
    model: SessionInteractionStore,
    interactions: readonly SessionInteraction[],
    messages: readonly SessionMessage[],
) {
    const permissions = interactions.flatMap((interaction) =>
        interaction.kind === "permission" &&
        interaction.permission.state.kind === "pending" &&
        model.submissions.get(interaction.permission.interactionId)?.kind !== "submitted"
            ? [interaction.permission]
            : [],
    );
    const elicitations = interactions.flatMap((interaction) =>
        interaction.kind === "elicitation" &&
        interaction.elicitation.state.kind === "pending" &&
        model.submissions.get(interaction.elicitation.interactionId)?.kind !== "submitted"
            ? [interaction.elicitation]
            : [],
    );
    const visibleIds = new Set([...permissions, ...elicitations].map((interaction) => interaction.interactionId));
    return {
        permissions,
        permissionPresentations: new Map(
            permissions.map((permission) => [permission.interactionId, permissionPresentation(permission)] as const),
        ),
        // What each field of a pending question shows: the user's answer so far, or the Agent's default.
        fieldValues: new Map(
            elicitations.flatMap((elicitation) =>
                elicitation.mode === "form"
                    ? [
                          [
                              elicitation.interactionId,
                              new Map(
                                  elicitation.fields.map(
                                      (field) =>
                                          [
                                              field.name,
                                              elicitationFieldValue(
                                                  field,
                                                  model.answerDrafts.get(elicitation.interactionId) ?? {},
                                              ),
                                          ] as const,
                                  ),
                              ),
                          ] as const,
                      ]
                    : [],
            ),
        ),
        fileChanges: new Map(
            permissions.map((permission) => [
                permission.interactionId,
                requestedFileChanges(messages, permission.toolCallId),
            ]),
        ),
        elicitations,
        requiredNotices: new Map(
            elicitations.flatMap((elicitation) => {
                if (elicitation.mode !== "form" || !model.acceptAttempts.has(elicitation.interactionId)) {
                    return [];
                }
                const missing = missingRequiredChoice(
                    elicitation.fields,
                    model.answerDrafts.get(elicitation.interactionId) ?? {},
                );
                return missing === undefined
                    ? []
                    : [[elicitation.interactionId, `Select an option for ${missing.title}.`] as const];
            }),
        ),
        busyInteractionIds: new Set(
            Array.from(model.submissions).flatMap(([id, operation]) => (operation.kind === "submitting" ? [id] : [])),
        ),
        error:
            Array.from(model.submissions).flatMap(([id, operation]) =>
                visibleIds.has(id) && operation.kind === "failed" ? [operation.message] : [],
            )[0] ?? "",
    };
}

export type PermissionPresentation = ReturnType<typeof permissionPresentation>;

function permissionPresentation(permission: PermissionInteraction) {
    return {
        cwd: permission.details.cwd,
        input:
            permission.details.rawInput == null
                ? "The agent did not provide the original tool input."
                : JSON.stringify(permission.details.rawInput, null, 2),
        locations: [
            ...new Set(
                permission.details.locations.map((location) =>
                    location.line == null ? location.path : `${location.path}:${location.line}`,
                ),
            ),
        ],
        options: permission.options.map((option) => ({
            optionId: option.optionId,
            label: permissionOptionLabel(option),
            allow: option.kind === "allow_once" || option.kind === "allow_always",
        })),
    };
}

/** Generic affirmatives/negatives carry no scope, so the label is derived from the option kind instead. */
const genericAnswerNames = new Set(["n", "no", "y", "yes"]);

type PermissionOption = PermissionInteraction["options"][number];

function scopeLabel(kind: PermissionOption["kind"]): string {
    switch (kind) {
        case "allow_once":
            return "Allow";
        case "allow_always":
            return "Allow for this session";
        case "reject_once":
            return "Deny";
        case "reject_always":
            return "Deny for this session";
        default: {
            const unexpected: never = kind;
            throw new Error(`Unsupported permission option: ${unexpected}`);
        }
    }
}

/** What a permission option's button and its recorded decision read. */
function permissionOptionLabel(option: PermissionOption): string {
    if (genericAnswerNames.has(option.name.trim().toLowerCase())) {
        return scopeLabel(option.kind);
    }
    const lower = option.name.toLowerCase();
    switch (option.kind) {
        case "allow_once":
        case "allow_always":
            return lower.startsWith("allow") ? option.name : `Allow: ${option.name}`;
        case "reject_once":
        case "reject_always":
            return lower.startsWith("deny") || lower.startsWith("reject") ? option.name : `Deny: ${option.name}`;
        default: {
            const unexpected: never = option.kind;
            throw new Error(`Unsupported permission option: ${unexpected}`);
        }
    }
}
