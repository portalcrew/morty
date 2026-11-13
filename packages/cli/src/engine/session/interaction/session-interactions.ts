import type {
    CompleteElicitationNotification,
    CreateElicitationRequest,
    CreateElicitationResponse,
    RequestPermissionRequest,
    RequestPermissionResponse,
} from "@agentclientprotocol/sdk/unstable";
import {
    type NativeSessionTarget,
    SESSION_ELICITATION_AWAITING_COMPLETION_KIND,
    SESSION_ELICITATION_REQUESTED_KIND,
    SESSION_ELICITATION_RESOLVED_KIND,
    SESSION_PERMISSION_REQUESTED_KIND,
    SESSION_PERMISSION_RESOLVED_KIND,
    type SessionElicitationAwaitingCompletionEvent,
    type SessionElicitationRequestedEvent,
    type SessionElicitationResolvedEvent,
    type SessionEventPayload,
    type SessionPermissionOption,
    type SessionPermissionRequestedEvent,
    type SessionPermissionResolvedEvent,
} from "@morty-build/client/protocol";
import { AcpExecutionError } from "../../acp/acp-error.ts";
import { normalizeElicitationFields, validateElicitationContent } from "../../acp/protocol/elicitation.ts";
import type { ProjectedToolCall } from "../../acp/tool-call-projection.ts";

import { readString, truncate } from "../../util/value-utils.ts";
import type { ElicitationResponseOptions, PermissionResponseOptions } from "../api/session-api.ts";
import { PendingElicitation, PendingPermission } from "./pending-interactions.ts";

/** What the user answered, as the Session records it to recognize a repeat of the same answer. */
type ElicitationAnswer =
    | { readonly action: "accept"; readonly schema: unknown; readonly content: string }
    | { readonly action: "accept-url" }
    | { readonly action: "decline" }
    | { readonly action: "cancel" };

// Form fields are scalar values or arrays. Field order and JSON whitespace do not change an answer.
function formAnswer(content: ReturnType<typeof validateElicitationContent>): string {
    return JSON.stringify(Object.entries(content).sort(([left], [right]) => left.localeCompare(right)));
}

interface SessionInteractionContext {
    readonly target: () => NativeSessionTarget;
    readonly cwd: () => string;
    /**
     * The tool call the event history projection holds for this identifier,
     * with the announcements of the current turn already merged. A permission
     * request is a partial ToolCallUpdate, so fields it omits are read from
     * this announcement.
     */
    readonly getToolCall: (toolCallId: string) => ProjectedToolCall | undefined;
    readonly commandId: () => string;
    readonly assertNativeSession: (sessionId: string) => void;
    readonly recordSessionEvent: (event: SessionEventPayload) => Promise<void>;
}
export class SessionInteractions {
    // A bounded receipt window for answers in this live Session. Eviction or Session replacement makes an
    // old answer unavailable, never implicitly successful. These are completed decisions, not pending requests.
    readonly #permissionAnswers = new Map<string, SessionPermissionResolvedEvent>();
    readonly #elicitationAnswers = new Map<string, ElicitationAnswer>();
    readonly #pendingPermissions = new Map<string, PendingPermission>();
    readonly #pendingElicitations = new Map<string, PendingElicitation>();
    readonly #acceptedUrlElicitations = new Map<string, SessionElicitationAwaitingCompletionEvent>();
    readonly #context: SessionInteractionContext;

    readonly snapshot = (): readonly (
        | SessionPermissionRequestedEvent
        | SessionElicitationRequestedEvent
        | SessionElicitationAwaitingCompletionEvent
    )[] => [
        ...[...this.#pendingPermissions.values()].map((pending) => pending.request),
        ...[...this.#pendingElicitations.values()].map((pending) => pending.request),
        ...this.#acceptedUrlElicitations.values(),
    ];
    constructor(context: SessionInteractionContext) {
        this.#context = context;
    }
    readonly #notifyPermissionRequested = async (event: SessionPermissionRequestedEvent): Promise<void> => {
        await this.#context.recordSessionEvent({
            payload: { event, kind: "session.permission.requested" },
            type: "lifecycle-metadata",
        });
    };
    readonly #notifyPermissionResolved = async (event: SessionPermissionResolvedEvent): Promise<void> => {
        await this.#context.recordSessionEvent({
            payload: { event, kind: "session.permission.resolved" },
            type: "lifecycle-metadata",
        });
    };
    readonly #notifyElicitationRequested = async (event: SessionElicitationRequestedEvent): Promise<void> => {
        await this.#context.recordSessionEvent({
            payload: { event, kind: "session.elicitation.requested" },
            type: "lifecycle-metadata",
        });
    };
    readonly #notifyElicitationResolved = async (event: SessionElicitationResolvedEvent): Promise<void> => {
        await this.#context.recordSessionEvent({
            payload: { event, kind: "session.elicitation.resolved" },
            type: "lifecycle-metadata",
        });
    };
    readonly respondPermission = async (options: PermissionResponseOptions): Promise<void> => {
        const answered = this.#permissionAnswers.get(options.interactionId);
        if (answered !== undefined) {
            const repeated =
                answered.outcome === "cancelled"
                    ? options.outcome === "cancelled"
                    : options.outcome === "selected" && options.optionId === answered.optionId;
            if (repeated) {
                return;
            }
            throw new AcpExecutionError(
                "The permission request has a different recorded answer",
                {},
                "permission_response_conflict",
            );
        }
        const pending = this.#pendingPermissions.get(options.interactionId);
        if (pending === undefined) {
            throw new AcpExecutionError(
                "The permission request is no longer active",
                {},
                "permission_request_not_found",
            );
        }
        if (options.outcome === "selected" && !pending.optionIds.has(options.optionId)) {
            throw new AcpExecutionError(
                "The selected permission option is unavailable",
                {},
                "invalid_permission_response",
            );
        }
        const resolved = options.outcome === "selected" ? pending.select(options.optionId) : pending.cancel();
        if (!resolved) {
            throw new AcpExecutionError(
                "The permission request was already resolved",
                {},
                "permission_request_not_found",
            );
        }
        this.#pendingPermissions.delete(options.interactionId);
        const answer: SessionPermissionResolvedEvent =
            options.outcome === "selected"
                ? {
                      interactionId: options.interactionId,
                      kind: SESSION_PERMISSION_RESOLVED_KIND,
                      optionId: options.optionId,
                      outcome: "selected",
                      target: this.#context.target(),
                  }
                : {
                      interactionId: options.interactionId,
                      kind: SESSION_PERMISSION_RESOLVED_KIND,
                      outcome: "cancelled",
                      target: this.#context.target(),
                  };
        this.#permissionAnswers.set(options.interactionId, answer);
        if (this.#permissionAnswers.size > 256) {
            const oldest = this.#permissionAnswers.keys().next().value;
            if (oldest !== undefined) {
                this.#permissionAnswers.delete(oldest);
            }
        }
        await this.#notifyPermissionResolved(answer);
    };

    readonly respondElicitation = async (options: ElicitationResponseOptions): Promise<void> => {
        const answered = this.#elicitationAnswers.get(options.interactionId);
        if (answered !== undefined) {
            if (this.#repeatsAnswer(answered, options)) {
                return;
            }
            throw new AcpExecutionError(
                "The elicitation request has a different recorded answer",
                {},
                "elicitation_response_conflict",
            );
        }
        const pending = this.#pendingElicitations.get(options.interactionId);
        if (pending === undefined) {
            throw new AcpExecutionError(
                "The elicitation request is no longer active",
                {},
                "elicitation_request_not_found",
            );
        }
        const request = pending.request;
        let resolved = false;
        let answer: ElicitationAnswer;
        switch (options.action) {
            case "accept": {
                if (request.mode !== "form") {
                    throw new AcpExecutionError(
                        "A URL elicitation is accepted by going to its URL",
                        {},
                        "invalid_elicitation_response",
                    );
                }
                const content = validateElicitationContent(options.content, pending.requestedSchema);
                answer = { action: "accept", schema: pending.requestedSchema, content: formAnswer(content) };
                resolved = pending.accept(content);
                break;
            }
            case "accept-url": {
                if (request.mode !== "url") {
                    throw new AcpExecutionError(
                        "A form elicitation is accepted with its content",
                        {},
                        "invalid_elicitation_response",
                    );
                }
                answer = { action: "accept-url" };
                resolved = pending.accept({});
                if (resolved) {
                    this.#acceptedUrlElicitations.set(request.elicitationId, {
                        commandId: request.commandId,
                        elicitationId: request.elicitationId,
                        interactionId: request.interactionId,
                        kind: SESSION_ELICITATION_AWAITING_COMPLETION_KIND,
                        message: request.message,
                        target: request.target,
                        url: request.url,
                    });
                }
                break;
            }
            case "decline":
                answer = { action: "decline" };
                resolved = pending.decline();
                break;
            case "cancel":
                answer = { action: "cancel" };
                resolved = pending.cancel();
                break;
            default:
                return options satisfies never;
        }
        if (!resolved) {
            throw new AcpExecutionError(
                "The elicitation request was already resolved",
                {},
                "elicitation_request_not_found",
            );
        }
        this.#pendingElicitations.delete(options.interactionId);
        this.#elicitationAnswers.set(options.interactionId, answer);
        if (this.#elicitationAnswers.size > 256) {
            const oldest = this.#elicitationAnswers.keys().next().value;
            if (oldest !== undefined) {
                this.#elicitationAnswers.delete(oldest);
            }
        }
        await this.#notifyElicitationResolved({
            action: options.action === "accept-url" ? "accept" : options.action,
            interactionId: options.interactionId,
            kind: SESSION_ELICITATION_RESOLVED_KIND,
            target: this.#context.target(),
        });
    };

    /** Whether `options` repeats the recorded answer; field order and JSON whitespace do not change an answer. */
    readonly #repeatsAnswer = (answered: ElicitationAnswer, options: ElicitationResponseOptions): boolean => {
        switch (answered.action) {
            case "accept":
                return (
                    options.action === "accept" &&
                    answered.content === formAnswer(validateElicitationContent(options.content, answered.schema))
                );
            case "accept-url":
            case "decline":
            case "cancel":
                return options.action === answered.action;
            default:
                return answered satisfies never;
        }
    };

    readonly onPermission = async (
        request: RequestPermissionRequest,
        signal: AbortSignal,
    ): Promise<RequestPermissionResponse> => {
        this.#context.assertNativeSession(request.sessionId);
        const interactionId = `permission-${crypto.randomUUID()}`;
        const options: SessionPermissionOption[] = request.options.slice(0, 20).map((option) => ({
            kind: option.kind,
            name: truncate(option.name, 255),
            optionId: truncate(option.optionId, 255),
        }));
        if (options.length === 0) {
            throw new AcpExecutionError(
                "ACP permission request did not provide any choices",
                {},
                "invalid_agent_permission_request",
            );
        }
        // A permission request is a partial ToolCallUpdate: a field it
        // omits keeps the value announced for the same tool call, which
        // the event history projection holds in merged form.
        const announced = this.#context.getToolCall(request.toolCall.toolCallId);
        const title = request.toolCall.title ?? announced?.title;
        const kind = request.toolCall.kind ?? announced?.kind;
        const rawInput = request.toolCall.rawInput ?? announced?.rawInput;
        const locations = request.toolCall.locations ?? announced?.locations ?? [];
        const event: SessionPermissionRequestedEvent = {
            commandId: this.#context.commandId(),
            details: {
                cwd: this.#context.cwd(),
                rawInput,
                locations,
            },
            interactionId,
            kind: SESSION_PERMISSION_REQUESTED_KIND,
            options,
            target: this.#context.target(),
            title: truncate(title ?? "Permission required", 500),
            toolCallId: truncate(request.toolCall.toolCallId, 255),
            toolKind: truncate(kind ?? "other", 64),
        };
        const pending = new PendingPermission(event);
        this.#pendingPermissions.set(interactionId, pending);
        const abort = (): void => {
            void this.cancelPermission(interactionId);
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
            await this.#notifyPermissionRequested(event);
            return await pending.completion.promise;
        } finally {
            signal.removeEventListener("abort", abort);
            this.#pendingPermissions.delete(interactionId);
        }
    };

    readonly onElicitation = async (
        request: CreateElicitationRequest,
        signal: AbortSignal,
    ): Promise<CreateElicitationResponse> => {
        const sessionId = Reflect.get(request, "sessionId");
        if (typeof sessionId !== "string") {
            throw new AcpExecutionError(
                "Morty only accepts session-scoped ACP elicitations",
                {},
                "unsupported_elicitation_scope",
            );
        }
        this.#context.assertNativeSession(sessionId);
        if (request.mode !== "form" && request.mode !== "url") {
            throw new AcpExecutionError(
                "The ACP agent requested an unsupported elicitation mode",
                {},
                "unsupported_elicitation_mode",
            );
        }
        const interactionId = `elicitation-${crypto.randomUUID()}`;
        const base = {
            commandId: this.#context.commandId(),
            interactionId,
            kind: SESSION_ELICITATION_REQUESTED_KIND,
            message: truncate(request.message, 2_000),
            target: this.#context.target(),
        } as const;
        let event: SessionElicitationRequestedEvent;
        let requestedSchema: unknown = {};
        if (request.mode === "form") {
            requestedSchema = Reflect.get(request, "requestedSchema");
            event = { ...base, fields: normalizeElicitationFields(requestedSchema), mode: "form" };
        } else {
            const elicitationId = Reflect.get(request, "elicitationId");
            const url = Reflect.get(request, "url");
            if (
                typeof elicitationId !== "string" ||
                elicitationId.length === 0 ||
                typeof url !== "string" ||
                url.length === 0
            ) {
                throw new AcpExecutionError(
                    "The ACP agent requested a URL elicitation without its identifier and URL",
                    {},
                    "invalid_agent_elicitation_request",
                );
            }
            event = {
                ...base,
                elicitationId: truncate(elicitationId, 255),
                mode: "url",
                url: truncate(readString(url), 4_096),
            };
        }
        const pending = new PendingElicitation(event, requestedSchema);
        this.#pendingElicitations.set(interactionId, pending);
        const abort = (): void => {
            void this.cancelElicitation(interactionId);
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
            await this.#notifyElicitationRequested(event);
            return await pending.completion.promise;
        } finally {
            signal.removeEventListener("abort", abort);
            this.#pendingElicitations.delete(interactionId);
        }
    };

    readonly onElicitationComplete = async (notification: CompleteElicitationNotification): Promise<void> => {
        // Requests name the identifier at the length the protocol keeps it.
        const elicitationId = truncate(notification.elicitationId, 255);
        const accepted = this.#acceptedUrlElicitations.get(elicitationId);
        if (accepted === undefined) {
            return;
        }
        this.#acceptedUrlElicitations.delete(elicitationId);
        await this.#notifyElicitationResolved({
            action: "complete",
            interactionId: accepted.interactionId,
            kind: SESSION_ELICITATION_RESOLVED_KIND,
            target: this.#context.target(),
        });
    };

    readonly cancelPermission = async (interactionId: string): Promise<void> => {
        const pending = this.#pendingPermissions.get(interactionId);
        if (pending === undefined || !pending.cancel()) {
            return;
        }
        this.#pendingPermissions.delete(interactionId);
        await this.#notifyPermissionResolved({
            interactionId,
            kind: SESSION_PERMISSION_RESOLVED_KIND,
            outcome: "cancelled",
            target: this.#context.target(),
        });
    };

    readonly cancelElicitation = async (interactionId: string): Promise<void> => {
        const pending = this.#pendingElicitations.get(interactionId);
        if (pending === undefined || !pending.cancel()) {
            return;
        }
        this.#pendingElicitations.delete(interactionId);
        await this.#notifyElicitationResolved({
            action: "cancel",
            interactionId,
            kind: SESSION_ELICITATION_RESOLVED_KIND,
            target: this.#context.target(),
        });
    };

    readonly cancelPendingInteractions = async (): Promise<void> => {
        const permissionIds = [...this.#pendingPermissions.keys()];
        const elicitationIds = [...this.#pendingElicitations.keys()];
        const acceptedElicitationIds = [...this.#acceptedUrlElicitations.values()].map(
            (request) => request.interactionId,
        );
        this.#acceptedUrlElicitations.clear();
        for (const interactionId of permissionIds) {
            await this.cancelPermission(interactionId);
        }
        for (const interactionId of elicitationIds) {
            await this.cancelElicitation(interactionId);
        }
        for (const interactionId of acceptedElicitationIds) {
            await this.#notifyElicitationResolved({
                action: "cancel",
                interactionId,
                kind: SESSION_ELICITATION_RESOLVED_KIND,
                target: this.#context.target(),
            });
        }
    };
}
