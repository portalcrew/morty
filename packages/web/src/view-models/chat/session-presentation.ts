import { externalContentPath } from "@morty-build/client";
import type {
    AcpSessionUpdate,
    AgentQuestion,
    ContentBlock,
    PromptCompletion,
    SessionEvent,
    SessionLiveEvent,
} from "@morty-build/client/protocol";
import type { AgentDisplayContent } from "../../components/agents/display-content.ts";
import {
    REASONING_CHARACTER_LIMIT,
    type SessionToolCallState,
    type SessionToolPresentation,
} from "../../components/chat/tools/tool-contract.ts";

type ToolCallUpdate = Extract<AcpSessionUpdate, { readonly sessionUpdate: "tool_call" | "tool_call_update" }>;

export const COMPACTION_CHARACTER_LIMIT = 16 * 1024;

export type SessionPresentationEvent = SessionEvent | SessionLiveEvent;

export type SessionText =
    | {
          readonly kind: "initial";
          readonly length: number;
          readonly truncated: boolean;
          readonly value: string;
      }
    | {
          readonly kind: "appended";
          readonly length: number;
          readonly previous: SessionText;
          readonly truncated: boolean;
          readonly value: string;
      };

type TextContentBlock = Extract<ContentBlock, { readonly type: "text" }>;
type SessionContentBlock =
    | (Omit<TextContentBlock, "text"> & { readonly text: SessionText })
    | Exclude<ContentBlock, TextContentBlock>;

export type SessionMessage =
    | {
          readonly role: "user";
          readonly firstEvent: SessionPresentationEvent;
          readonly commandId: string | null;
          readonly contents: readonly ContentBlock[];
          /**
           * Whether this message starts an execution or steers the one already
           * running. Messages reported by the Agent itself carry no lifecycle and
           * are `unknown`.
           */
          readonly execution: "starts" | "steers" | "unknown";
      }
    | {
          readonly role: "assistant";
          readonly firstEvent: SessionPresentationEvent;
          readonly commandId: string | null;
          readonly presentation:
              | {
                    readonly kind: "message";
                    readonly content: SessionContentBlock;
                    readonly messageId: string;
                    /** Questions the message asks while the Agent keeps working; the user answers with a message. */
                    readonly questions: readonly AgentQuestion[];
                }
              | { readonly kind: "thought"; readonly content: SessionContentBlock; readonly messageId: string }
              | { readonly kind: "tool"; readonly entry: SessionToolPresentation }
              | {
                    readonly kind: "compaction";
                    readonly compactionId: string;
                    readonly error: string | null;
                    readonly status: "in_progress" | "completed" | "failed" | "cancelled";
                    readonly summary: SessionText | null;
                }
              | { readonly kind: "completed"; readonly completion: PromptCompletion }
              | { readonly kind: "failure"; readonly code: string; readonly message: string };
      };

export interface SessionTimeline {
    readonly messages: readonly SessionMessage[];
}

export type SessionExecutionMessage = SessionMessage & {
    readonly executionContext:
        | { readonly kind: "unmanaged" }
        | { readonly kind: "managed"; readonly commandId: string };
};

/** Released events can omit command identity; resolve it once at the history adapter. */
export function sessionUserCommandIds(messages: readonly SessionExecutionMessage[]): readonly string[] {
    return messages.flatMap((message) => {
        if (message.role !== "user") {
            return [];
        }
        const commandId =
            message.commandId ??
            (message.executionContext.kind === "managed" ? message.executionContext.commandId : null);
        return commandId === null ? [] : [commandId];
    });
}

function exhaustive(value: never): never {
    throw new Error(`Unsupported Session Event Log payload: ${JSON.stringify(value)}`);
}

function encodedJson(value: unknown): string {
    if (value === undefined || value === null) {
        return "";
    }
    return typeof value === "string" ? value : JSON.stringify(value);
}

function initialSessionText(value: string, limit?: number): SessionText {
    const truncated = limit !== undefined && value.length > limit;
    const retained = truncated ? value.slice(-limit) : value;
    return { kind: "initial", length: retained.length, truncated, value: retained };
}

function sessionContent(content: ContentBlock, textLimit?: number): SessionContentBlock {
    return content.type === "text" ? { ...content, text: initialSessionText(content.text, textLimit) } : content;
}

export function sessionTextValue(text: SessionText): string {
    const chunks: string[] = [];
    let current: SessionText = text;
    for (;;) {
        chunks.push(current.value);
        if (current.kind === "initial") {
            break;
        }
        current = current.previous;
    }
    chunks.reverse();
    return chunks.join("");
}

function appendSessionText(previous: SessionText, incoming: SessionText, prefix: string, limit?: number): SessionText {
    const value = `${prefix}${sessionTextValue(incoming)}`;
    const length = previous.length + value.length;
    const truncated = previous.truncated || incoming.truncated;
    if (limit === undefined || length <= limit) {
        return { kind: "appended", length, previous, truncated, value };
    }
    const previousLength = Math.max(0, limit - value.length);
    const retainedPrevious = previousLength === 0 ? "" : sessionTextValue(previous).slice(-previousLength);
    const retained = `${retainedPrevious}${value.slice(-limit)}`;
    return { kind: "initial", length: retained.length, truncated: true, value: retained };
}

function displayContent(update: ToolCallUpdate): readonly AgentDisplayContent[] {
    return (update.content ?? []).map((item): AgentDisplayContent => {
        if (item.type === "diff") {
            return {
                newText: item.newText,
                oldText: item.oldText ?? "",
                path: item.path,
                type: "diff",
            };
        }
        if (item.type === "terminal") {
            return {
                terminalId: item.terminalId,
                type: "terminal",
            };
        }
        const content = item.content;
        switch (content.type) {
            case "text":
                return {
                    text: content.text,
                    type: "text",
                };
            case "image":
                return {
                    data: content.data,
                    mimeType: content.mimeType,
                    name: "",
                    type: "image",
                    uri: content.uri ?? "",
                };
            case "audio":
                return {
                    data: content.data,
                    mimeType: content.mimeType,
                    name: "Audio",
                    text: "",
                    type: "resource",
                    uri: "",
                };
            case "resource_link":
                return {
                    mimeType: content.mimeType ?? "",
                    name: content.name,
                    text: content.description ?? "",
                    type: "resource_link",
                    uri: content.uri,
                };
            case "resource":
                return {
                    data: "blob" in content.resource ? content.resource.blob : "",
                    mimeType: content.resource.mimeType ?? "",
                    name: content.resource.uri,
                    text: "text" in content.resource ? content.resource.text : "",
                    type: "resource",
                    uri: content.resource.uri,
                };
            case "external_image":
                return {
                    data: "",
                    mimeType: content.mimeType,
                    name: "Image",
                    type: "image",
                    uri: externalContentPath(content),
                };
            case "external_audio":
                return {
                    data: "",
                    mimeType: content.mimeType,
                    name: "Audio",
                    text: "",
                    type: "resource",
                    uri: externalContentPath(content),
                };
            case "external_resource":
                return {
                    data: "",
                    mimeType: content.mimeType ?? "",
                    name: content.uri,
                    text: "",
                    type: "resource",
                    uri: externalContentPath(content),
                };
            default:
                return exhaustive(content);
        }
    });
}

function toolState(status: ToolCallUpdate["status"]): SessionToolCallState {
    switch (status) {
        case "pending":
        case "in_progress":
            return { kind: "running" };
        case "completed":
            return { kind: "succeeded" };
        case "failed":
            return { kind: "failed" };
        case null:
        case undefined:
            return { kind: "unknown" };
        default:
            return exhaustive(status);
    }
}

function mergeToolPresentation(
    previous: SessionToolPresentation | null,
    update: ToolCallUpdate,
): SessionToolPresentation {
    return {
        content: update.content === undefined ? (previous?.content ?? []) : displayContent(update),
        id: update.toolCallId,
        input: update.rawInput === undefined ? (previous?.input ?? "") : encodedJson(update.rawInput),
        kind: "tool",
        name: update.name === undefined ? (previous?.name ?? "") : (update.name ?? ""),
        output: update.rawOutput === undefined ? (previous?.output ?? "") : encodedJson(update.rawOutput),
        state:
            update.backgroundTask !== undefined
                ? { kind: "background", status: update.backgroundTask.status }
                : previous?.state.kind === "background"
                  ? previous.state
                  : update.status === undefined
                    ? (previous?.state ?? { kind: "unknown" })
                    : toolState(update.status),
        title:
            update.title === undefined ? (previous?.title ?? update.toolCallId) : (update.title ?? update.toolCallId),
    };
}

function userDisplayContent(content: ContentBlock): ContentBlock {
    if (content.type !== "text") {
        return content;
    }
    const context =
        /^\s*<in-app-browser-context\s+source="ambient-ui-state">[\s\S]*?<\/in-app-browser-context>\s*## My request:\s*\r?\n/u;
    return { ...content, text: content.text.replace(context, "") };
}

type CompactionPresentation = Extract<SessionMessage, { role: "assistant" }>["presentation"] & {
    readonly kind: "compaction";
};
type CompactionUpdateVariant = Extract<AcpSessionUpdate, { readonly sessionUpdate: "compaction_update" }>;
type CompactionChunkVariant = Extract<AcpSessionUpdate, { readonly sessionUpdate: "compaction_summary_chunk" }>;

/** Applies ACP compaction patch semantics: chunks append to the streamed summary;
 *  a terminal update patches status/error, and its `summary` (when concrete)
 *  replaces the streamed one. */
function mergeCompactionPresentation(
    previous: CompactionPresentation | null,
    update: CompactionUpdateVariant | CompactionChunkVariant,
): CompactionPresentation {
    if (update.sessionUpdate === "compaction_summary_chunk") {
        const text = update.content.type === "text" ? update.content.text : "";
        const summary =
            previous !== null && text.length > 0
                ? appendSessionText(
                      previous.summary ?? initialSessionText(""),
                      initialSessionText(text, COMPACTION_CHARACTER_LIMIT),
                      "",
                      COMPACTION_CHARACTER_LIMIT,
                  )
                : text.length > 0
                  ? initialSessionText(text, COMPACTION_CHARACTER_LIMIT)
                  : (previous?.summary ?? null);
        return {
            compactionId: update.compactionId,
            error: previous?.error ?? null,
            kind: "compaction",
            status: previous?.status ?? "in_progress",
            summary,
        };
    }
    const replacement =
        update.summary === undefined || update.summary === null
            ? (previous?.summary ?? null)
            : compactionSummary(update.summary);
    return {
        compactionId: update.compactionId,
        error: Object.hasOwn(update, "error") ? (update.error ?? null) : (previous?.error ?? null),
        kind: "compaction",
        status: compactionStatus(update.status, previous?.status ?? "in_progress"),
        summary: replacement,
    };
}

function compactionSummary(summary: readonly ContentBlock[]): SessionText | null {
    // A terminal summary may span several text blocks; they read as one summary,
    // so aggregate them in order before applying the retention limit.
    const text = summary
        .flatMap((block) => (block?.type === "text" && block.text.length > 0 ? [block.text] : []))
        .join("");
    return text.length > 0 ? initialSessionText(text, COMPACTION_CHARACTER_LIMIT) : null;
}

function compactionStatus(
    status: string,
    fallback: NonNullable<CompactionPresentation["status"]>,
): NonNullable<CompactionPresentation["status"]> {
    switch (status) {
        case "in_progress":
        case "completed":
        case "failed":
        case "cancelled":
            return status;
        default:
            return fallback;
    }
}

function messageFromAcpUpdate(event: SessionPresentationEvent, update: AcpSessionUpdate): SessionMessage | null {
    switch (update.sessionUpdate) {
        case "user_message_chunk": {
            return {
                commandId: null,
                contents: [userDisplayContent(update.content)],
                execution: "unknown",
                firstEvent: event,
                role: "user",
            };
        }
        case "agent_message_chunk":
            return {
                commandId: null,
                firstEvent: event,
                presentation: {
                    content: sessionContent(update.content),
                    kind: "message",
                    messageId: update.messageId,
                    questions: update.questions ?? [],
                },
                role: "assistant",
            };
        case "agent_thought_chunk":
            return {
                commandId: null,
                firstEvent: event,
                presentation: {
                    content: sessionContent(update.content, REASONING_CHARACTER_LIMIT),
                    kind: "thought",
                    messageId: update.messageId,
                },
                role: "assistant",
            };
        case "tool_call":
        case "tool_call_update":
            return null;
        case "compaction_update":
        case "compaction_summary_chunk":
            return null;
        case "available_commands_update":
        case "config_option_update":
        case "current_mode_update":
        case "plan":
        case "session_info_update":
        case "usage_update":
            return null;
        default:
            return exhaustive(update);
    }
}

type SessionEventResult =
    | { readonly kind: "consumed"; readonly index: number; readonly message: SessionMessage }
    | { readonly kind: "turn-started"; readonly commandId: string }
    | {
          readonly kind: "turn-requested";
          readonly commandId: string;
          readonly executionCommandId: string;
          readonly execution: "starts" | "steers";
      }
    | {
          readonly kind: "turn-ended";
          readonly message: SessionMessage;
      }
    | {
          readonly kind: "constructed";
          readonly firstEvent: FirstEventProvenance;
          readonly message: SessionMessage;
      }
    | { readonly kind: "skipped" };

function mergeAdjacentText(previous: SessionMessage | undefined, incoming: SessionMessage): SessionMessage | null {
    if (
        previous?.role !== "assistant" ||
        incoming.role !== "assistant" ||
        previous.presentation.kind !== incoming.presentation.kind ||
        (incoming.presentation.kind !== "message" && incoming.presentation.kind !== "thought") ||
        (previous.presentation.kind !== "message" && previous.presentation.kind !== "thought") ||
        (incoming.presentation.kind === "message" &&
            previous.presentation.messageId !== incoming.presentation.messageId) ||
        previous.presentation.content.type !== "text" ||
        incoming.presentation.content.type !== "text"
    ) {
        return null;
    }
    // A message's questions arrive with one of its chunks; later chunks keep them.
    const presentation =
        incoming.presentation.kind === "message" &&
        previous.presentation.kind === "message" &&
        incoming.presentation.questions.length === 0
            ? { ...incoming.presentation, questions: previous.presentation.questions }
            : incoming.presentation;
    return {
        ...previous,
        presentation: {
            ...presentation,
            content: {
                ...incoming.presentation.content,
                text: appendSessionText(
                    previous.presentation.content.text,
                    incoming.presentation.content.text,
                    incoming.presentation.kind === "thought" &&
                        previous.presentation.messageId !== incoming.presentation.messageId
                        ? "\n\n"
                        : "",
                    incoming.presentation.kind === "thought" ? REASONING_CHARACTER_LIMIT : undefined,
                ),
            },
        },
    };
}

/** What the page knows about an entry's first event.
 *  - "known": the entity's first event is on this page (or merged in); the
 *    entry renders and retains no events.
 *  - "possibly-before-page": the entity may have begun on an unobserved older
 *    page and the entry cannot render without its start (a bare tool-call
 *    tail); events stay retained for the merge and it hides until then.
 *  - "possibly-before-page-visible": the entity may have begun on an older
 *    page, but any observed event renders it (an id-addressed compaction);
 *    events stay retained and it renders while the merge is outstanding. */
type FirstEventProvenance = "known" | "possibly-before-page" | "possibly-before-page-visible";

interface ReducedSessionMessage {
    readonly kind: "message";
    readonly message: SessionMessage;
    readonly provenance: FirstEventProvenance;
    readonly unresolvedEvents: readonly SessionPresentationEvent[];
}

/**
 * The log position of a live event. A history page states only the position it reads through, so its events have none:
 * all of them come before everything the stream delivers after that page.
 */
function eventPosition(event: SessionPresentationEvent): string | null {
    return "position" in event ? event.position : null;
}

/** A turn the Computer's log says started, at the log position of the event that said it. */
interface StartedTurnEntry {
    readonly kind: "turn-started";
    readonly commandId: string;
    readonly position: string | null;
}

/** Which execution a command's request belongs to: its own, or the one it steers. */
interface ExecutionOwnerEntry {
    readonly kind: "execution-owner";
    readonly commandId: string;
    readonly executionCommandId: string;
    readonly execution: "starts" | "steers";
    readonly position: string | null;
}

type ReducedSessionEntry = ReducedSessionMessage | StartedTurnEntry | ExecutionOwnerEntry;

/**
 * What the Computer reported of the Session's execution. It is placed in the timeline by the log position it covers,
 * so the timeline is a function of the events and the reports, and neither holds the other's facts.
 */
export type SessionExecutionObservation =
    /** The Computer's account of the execution through `position` of the log's `generation`. */
    | {
          readonly kind: "through";
          readonly generation: string;
          readonly position: string;
          readonly running: string | null;
          readonly queued: readonly string[];
      }
    /** The Computer closed the Session: nothing runs and no more events follow. */
    | { readonly kind: "closed" };

/** What a report says at its place in the timeline, which the messages after it are read against. */
type ExecutionMarker =
    | StartedTurnEntry
    | ExecutionOwnerEntry
    | { readonly kind: "execution-idle" }
    | { readonly kind: "queued-command"; readonly commandId: string };

type TimelineEntry = ReducedSessionEntry | ExecutionMarker;

export interface SessionMessageReduction {
    readonly entries: readonly ReducedSessionEntry[];
}

type TurnEndingPayload = Extract<
    Extract<SessionPresentationEvent, { readonly type: "lifecycle-metadata" }>["payload"],
    { readonly kind: "prompt.completed" | "prompt.failed" | "prompt.failed-before-start" }
>;

function turnEnding(event: SessionPresentationEvent, lifecycle: TurnEndingPayload): SessionMessage {
    return {
        role: "assistant",
        commandId: lifecycle.commandId,
        firstEvent: event,
        presentation:
            lifecycle.kind === "prompt.completed"
                ? { kind: "completed", completion: lifecycle.completion }
                : { kind: "failure", code: lifecycle.code, message: lifecycle.message },
    };
}

function consumeSessionEvent(
    entries: readonly ReducedSessionEntry[],
    event: SessionPresentationEvent,
    leadingEvent: "known" | "possibly-before-page",
): SessionEventResult {
    if (event.type === "lifecycle-metadata") {
        const lifecycle = event.payload;
        if (lifecycle.kind === "prompt.started") {
            return { kind: "turn-started", commandId: lifecycle.commandId };
        }
        if (
            lifecycle.kind === "prompt.completed" ||
            lifecycle.kind === "prompt.failed" ||
            lifecycle.kind === "prompt.failed-before-start"
        ) {
            return { kind: "turn-ended", message: turnEnding(event, lifecycle) };
        }
        if (lifecycle.kind === "prompt.requested") {
            return {
                kind: "turn-requested",
                commandId: lifecycle.commandId,
                executionCommandId:
                    lifecycle.dispatch.kind === "steer" ? lifecycle.dispatch.targetCommandId : lifecycle.commandId,
                execution: lifecycle.dispatch.kind === "steer" ? "steers" : "starts",
            };
        }
        return { kind: "skipped" };
    }
    const update = event.payload;
    if (update.sessionUpdate === "compaction_update" || update.sessionUpdate === "compaction_summary_chunk") {
        const existingIndex = entries.findIndex(
            (entry) =>
                entry.kind === "message" &&
                entry.message.role === "assistant" &&
                entry.message.presentation.kind === "compaction" &&
                entry.message.presentation.compactionId === update.compactionId,
        );
        const existingEntry = entries[existingIndex];
        const existing = existingEntry?.kind === "message" ? existingEntry.message : undefined;
        const previous =
            existing?.role === "assistant" && existing.presentation.kind === "compaction"
                ? existing.presentation
                : null;
        const message: SessionMessage = {
            commandId: null,
            firstEvent: existing?.firstEvent ?? event,
            presentation: mergeCompactionPresentation(previous, update),
            role: "assistant",
        };
        return existingIndex === -1
            ? {
                  // The entry keeps its events for cross-page merging whenever its
                  // own start (a leading in_progress per the ACP contract) has not
                  // been observed on this page, but it renders immediately: any of
                  // its events establishes the id-addressed entity, so the current
                  // state (streaming or settled) is visible without waiting for the
                  // older page that holds the start.
                  firstEvent:
                      update.sessionUpdate === "compaction_update" && update.status === "in_progress"
                          ? "known"
                          : leadingEvent === "known"
                            ? "known"
                            : "possibly-before-page-visible",
                  kind: "constructed",
                  message,
              }
            : { index: existingIndex, kind: "consumed", message };
    }
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
        const message = messageFromAcpUpdate(event, update);
        if (message === null) {
            return { kind: "skipped" };
        }
        if (message.role === "user" && update.sessionUpdate === "user_message_chunk") {
            const existingIndex = entries.findIndex((entry) => {
                if (entry.kind !== "message" || entry.message.role !== "user") {
                    return false;
                }
                const first = entry.message.firstEvent;
                return (
                    first.type === "acp" &&
                    first.payload.sessionUpdate === "user_message_chunk" &&
                    first.payload.messageId === update.messageId
                );
            });
            const existing = entries[existingIndex];
            if (existing?.kind === "message" && existing.message.role === "user") {
                return {
                    index: existingIndex,
                    kind: "consumed",
                    message: { ...existing.message, contents: [...existing.message.contents, ...message.contents] },
                };
            }
        }
        const previousIndex = entries.length - 1;
        const previous = entries[previousIndex];
        const merged = mergeAdjacentText(previous?.kind === "message" ? previous.message : undefined, message);
        return merged === null
            ? {
                  firstEvent:
                      message.role === "user" &&
                      update.sessionUpdate === "user_message_chunk" &&
                      entries.length === 0 &&
                      leadingEvent !== "known"
                          ? "possibly-before-page-visible"
                          : entries.length === 0
                            ? leadingEvent
                            : "known",
                  kind: "constructed",
                  message,
              }
            : { index: previousIndex, kind: "consumed", message: merged };
    }
    const existingIndex = entries.findIndex(
        (entry) =>
            entry.kind === "message" &&
            entry.message.role === "assistant" &&
            entry.message.presentation.kind === "tool" &&
            entry.message.presentation.entry.id === update.toolCallId,
    );
    const existingEntry = entries[existingIndex];
    const existing = existingEntry?.kind === "message" ? existingEntry.message : undefined;
    const previous =
        existing?.role === "assistant" && existing.presentation.kind === "tool" ? existing.presentation.entry : null;
    const message: SessionMessage = {
        commandId: null,
        firstEvent: existing?.firstEvent ?? event,
        presentation: { entry: mergeToolPresentation(previous, update), kind: "tool" },
        role: "assistant",
    };
    return existingIndex === -1
        ? {
              firstEvent: update.sessionUpdate === "tool_call" ? "known" : "possibly-before-page",
              kind: "constructed",
              message,
          }
        : { index: existingIndex, kind: "consumed", message };
}

function applySessionEvent(
    entries: readonly ReducedSessionEntry[],
    event: SessionPresentationEvent,
    result: SessionEventResult,
): readonly ReducedSessionEntry[] {
    switch (result.kind) {
        case "turn-requested": {
            return [
                ...entries,
                {
                    kind: "execution-owner",
                    commandId: result.commandId,
                    executionCommandId: result.executionCommandId,
                    execution: result.execution,
                    position: eventPosition(event),
                },
            ];
        }
        case "turn-ended": {
            return applySessionEvent(entries, event, {
                kind: "constructed",
                firstEvent: "known",
                message: result.message,
            });
        }
        case "turn-started":
            return [...entries, { kind: "turn-started", commandId: result.commandId, position: eventPosition(event) }];
        case "consumed": {
            const previous = entries[result.index];
            if (previous?.kind !== "message") {
                return entries;
            }
            const next = [...entries];
            next[result.index] = {
                kind: "message",
                message: result.message,
                provenance: previous.provenance,
                unresolvedEvents: previous.provenance === "known" ? [] : [...previous.unresolvedEvents, event],
            };
            return next;
        }
        case "constructed":
            return [
                ...entries,
                {
                    kind: "message",
                    message: result.message,
                    provenance: result.firstEvent,
                    unresolvedEvents: result.firstEvent === "known" ? [] : [event],
                },
            ];
        case "skipped":
            return entries;
        default:
            return exhaustive(result);
    }
}

/** Reduces a page of events, which holds each turn's lifecycle where it happened, exactly as the live stream does. */
function reduceSessionEvents(
    events: readonly SessionPresentationEvent[],
    leadingEvent: "known" | "possibly-before-page",
): SessionMessageReduction {
    let entries: readonly ReducedSessionEntry[] = [];
    for (const event of events) {
        entries = applySessionEvent(entries, event, consumeSessionEvent(entries, event, leadingEvent));
    }
    return { entries };
}

export function createSessionMessageReduction(history: {
    readonly events: readonly SessionPresentationEvent[];
    readonly nextCursor: string | null;
}): SessionMessageReduction {
    return reduceSessionEvents(history.events, history.nextCursor === null ? "known" : "possibly-before-page");
}

function mergeSessionEventSequences(
    first: readonly SessionPresentationEvent[],
    second: readonly SessionPresentationEvent[],
): readonly SessionPresentationEvent[] {
    const events = new Map(first.map((event) => [event.eventId, event]));
    for (const event of second) {
        events.set(event.eventId, event);
    }
    return [...events.values()];
}

export function appendSessionMessageEvent(
    reduction: SessionMessageReduction,
    event: SessionPresentationEvent,
): SessionMessageReduction {
    return {
        entries: applySessionEvent(reduction.entries, event, consumeSessionEvent(reduction.entries, event, "known")),
    };
}

export function prependSessionMessageEvents(
    reduction: SessionMessageReduction,
    history: {
        readonly events: readonly SessionPresentationEvent[];
        readonly nextCursor: string | null;
    },
): SessionMessageReduction {
    const unresolvedEvents = reduction.entries.flatMap((entry) =>
        entry.kind === "message" ? entry.unresolvedEvents : [],
    );
    const older = reduceSessionEvents(
        mergeSessionEventSequences(history.events, unresolvedEvents),
        history.nextCursor === null ? "known" : "possibly-before-page",
    );
    // Entries with retained events were replayed into the older reduction, where
    // their ids merge under one entity with the start events this page lacked;
    // they are superseded and dropped here. "known" entries have nothing to
    // merge and are kept as-is.
    return {
        entries: [
            ...older.entries,
            ...reduction.entries.filter((entry) => entry.kind !== "message" || entry.provenance === "known"),
        ],
    };
}

export function sessionReductionExecutionOwner(reduction: SessionMessageReduction, commandId: string): string | null {
    const owner = reduction.entries.find((entry) => entry.kind === "execution-owner" && entry.commandId === commandId);
    return owner?.kind === "execution-owner" ? owner.executionCommandId : null;
}

/** Where in the log an entry begins: its first event's position, none for an entry the history page holds. */
function entryPosition(entry: ReducedSessionEntry): bigint | null {
    const position = entry.kind === "message" ? eventPosition(entry.message.firstEvent) : entry.position;
    return position === null ? null : BigInt(position);
}

/** What the Computer's report says at its place in the timeline. */
function observationMarkers(observation: SessionExecutionObservation): readonly ExecutionMarker[] {
    if (observation.kind === "closed" || observation.running === null) {
        // Native replay can retain unfinished tools without Morty lifecycle metadata.
        return [{ kind: "execution-idle" }];
    }
    return [
        {
            kind: "execution-owner",
            commandId: observation.running,
            executionCommandId: observation.running,
            execution: "starts",
            position: null,
        },
        { kind: "turn-started", commandId: observation.running, position: null },
        ...observation.queued.map((commandId): ExecutionMarker => ({ kind: "queued-command", commandId })),
    ];
}

/**
 * The entries with the Computer's reports placed among them: a report follows every entry that begins at or before the
 * log position it covers. `observations` are those of this reduction's log generation that cover its history baseline.
 */
function placeObservations(
    entries: readonly ReducedSessionEntry[],
    observations: readonly SessionExecutionObservation[],
): readonly TimelineEntry[] {
    if (observations.length === 0) {
        return entries;
    }
    const after = new Map<number, ExecutionMarker[]>();
    for (const observation of observations) {
        let end = entries.length;
        if (observation.kind === "through") {
            const covered = BigInt(observation.position);
            for (let index = entries.length - 1; index >= 0; index -= 1) {
                const entry = entries[index];
                const position = entry === undefined ? null : entryPosition(entry);
                if (position === null || position <= covered) {
                    break;
                }
                end = index;
            }
        }
        after.set(end, [...(after.get(end) ?? []), ...observationMarkers(observation)]);
    }
    const placed: TimelineEntry[] = [...(after.get(0) ?? [])];
    entries.forEach((entry, index) => {
        placed.push(entry, ...(after.get(index + 1) ?? []));
    });
    return placed;
}

export function sessionReductionMessages(
    reduction: SessionMessageReduction,
    observations: readonly SessionExecutionObservation[] = [],
): readonly SessionExecutionMessage[] {
    const messages: SessionExecutionMessage[] = [];
    const unfinished = new Map<string | null, number[]>();
    const executionOwners = new Map<string, string>();
    const entries = placeObservations(reduction.entries, observations);
    const queuedCommands = new Set(
        entries.flatMap((entry) => (entry.kind === "queued-command" ? [entry.commandId] : [])),
    );
    const startedCommands = new Set(
        entries.flatMap((entry) => (entry.kind === "turn-started" ? [entry.commandId] : [])),
    );
    let turn: { readonly kind: "unknown" } | { readonly kind: "active" | "terminal"; readonly commandId: string } = {
        kind: "unknown",
    };
    const interrupt = (indexes: readonly number[]) => {
        for (const index of indexes) {
            const pending = messages[index];
            if (pending?.role === "assistant" && pending.presentation.kind === "tool") {
                messages[index] = {
                    ...pending,
                    presentation: {
                        ...pending.presentation,
                        entry: { ...pending.presentation.entry, state: { kind: "interrupted" } },
                    },
                };
            }
        }
    };
    for (const entry of entries) {
        if (entry.kind === "queued-command") {
            continue;
        }
        if (entry.kind === "execution-owner") {
            executionOwners.set(entry.commandId, entry.executionCommandId);
            continue;
        }
        if (entry.kind === "execution-idle") {
            for (const indexes of unfinished.values()) {
                interrupt(indexes);
            }
            unfinished.clear();
            turn = { kind: "unknown" };
            continue;
        }
        if (entry.kind === "turn-started") {
            // A started event alone does not identify its execution: the request may be
            // on an older page and could describe steering of another command.
            const owner = executionOwners.get(entry.commandId);
            turn = owner === undefined ? { kind: "unknown" } : { kind: "active", commandId: owner };
            continue;
        }
        // A bare tool tail cannot render until the older page containing its start arrives.
        if (entry.provenance === "possibly-before-page") {
            continue;
        }
        let message = entry.message;
        // Suppress only confirmed unstarted work. A history baseline omits lifecycle
        // events, so an unknown command may be a real turn stopped during reconciliation.
        if (
            message.role === "assistant" &&
            message.presentation.kind === "completed" &&
            message.presentation.completion.kind === "cancelled" &&
            message.commandId !== null &&
            (!message.presentation.completion.started ||
                (queuedCommands.has(message.commandId) && !startedCommands.has(message.commandId)))
        ) {
            continue;
        }
        if (message.role === "user" && message.firstEvent.type === "acp" && turn.kind === "terminal") {
            turn = { kind: "unknown" };
        }
        if (
            message.role === "assistant" &&
            message.presentation.kind === "tool" &&
            message.presentation.entry.state.kind === "running"
        ) {
            const commandId = message.commandId ?? (turn.kind === "unknown" ? null : turn.commandId);
            if (turn.kind === "terminal" && commandId === turn.commandId) {
                // An ACP notification already in flight can arrive after the turn fails.
                message = {
                    ...message,
                    presentation: {
                        ...message.presentation,
                        entry: { ...message.presentation.entry, state: { kind: "interrupted" } },
                    },
                };
            } else {
                const indexes = unfinished.get(commandId) ?? [];
                indexes.push(messages.length);
                unfinished.set(commandId, indexes);
            }
        }
        messages.push({
            ...message,
            executionContext:
                turn.kind === "unknown" ? { kind: "unmanaged" } : { kind: "managed", commandId: turn.commandId },
        });
        const event = message.firstEvent;
        if (event.type !== "lifecycle-metadata") {
            continue;
        }
        const terminal = event.payload;
        if (
            terminal.kind !== "prompt.failed" &&
            (terminal.kind !== "prompt.completed" || terminal.completion.kind === "steered")
        ) {
            continue;
        }
        // Unknown ownership occurs when a page starts midway through a turn. Its terminal
        // event settles those tools too; prepending history recalculates ownership in order.
        for (const owner of [terminal.commandId, null]) {
            interrupt(unfinished.get(owner) ?? []);
            unfinished.delete(owner);
        }
        if (turn.kind === "unknown" || turn.commandId === terminal.commandId) {
            turn = { kind: "terminal", commandId: terminal.commandId };
        }
    }
    return messages;
}

export function sessionEventLogPresentation(events: readonly SessionPresentationEvent[]): SessionTimeline {
    return { messages: sessionReductionMessages(reduceSessionEvents(events, "known")) };
}

/**
 * The commands these events name. An Agent's user message identity is its own, not
 * the command that submitted it, so only lifecycle events identify commands.
 */
export function sessionEventCommandIds(events: readonly SessionPresentationEvent[]): readonly string[] {
    const commandIds: string[] = [];
    for (const event of events) {
        if (
            event.type === "lifecycle-metadata" &&
            "commandId" in event.payload &&
            !commandIds.includes(event.payload.commandId)
        ) {
            commandIds.push(event.payload.commandId);
        }
    }
    return commandIds;
}

/**
 * The outcome of the execution a message belongs to. Steering adds user
 * messages to a running execution without starting a new one, so an execution
 * can span several user messages.
 */
export type SessionExecutionState =
    /** Still running, or has not reported an outcome yet. */
    | { readonly kind: "open" }
    /** Completed, failed, or stopped before completing. */
    | { readonly kind: "ended" };

function terminalExecutionState(message: SessionMessage): SessionExecutionState | null {
    if (message.role !== "assistant") {
        return null;
    }
    const presentation = message.presentation;
    if (presentation.kind === "failure") {
        return { kind: "ended" };
    }
    if (presentation.kind !== "completed" || presentation.completion.kind === "steered") {
        return null;
    }
    return { kind: "ended" };
}

/** Returns, for each message, the state of the execution that owns it. */
export function sessionExecutionStates(
    messages: readonly SessionExecutionMessage[],
    sessionWorking: boolean,
): readonly SessionExecutionState[] {
    interface Span {
        readonly start: number;
        managed: boolean;
        terminal: SessionExecutionState | null;
    }
    const spans: Span[] = [];
    let current: Span = { start: 0, managed: false, terminal: null };
    let executionCommandId: string | null = null;
    for (const [index, message] of messages.entries()) {
        const context = message.executionContext;
        if (context.kind === "managed") {
            if (index > current.start && executionCommandId !== context.commandId) {
                spans.push(current);
                current = { start: index, managed: true, terminal: null };
            }
            executionCommandId = context.commandId;
            current.managed = true;
        }
        if (index > 0 && message.role === "user") {
            const starts =
                context.kind === "unmanaged" &&
                (message.execution === "starts" ||
                    // An Agent-reported user message cannot interrupt an execution Morty
                    // is still waiting on; it may be the Agent echoing a steering message.
                    (message.execution === "unknown" && !(current.managed && current.terminal === null)));
            if (starts) {
                spans.push(current);
                current = { start: index, managed: false, terminal: null };
                executionCommandId = null;
            }
        }
        if (message.role === "user" && message.execution !== "unknown") {
            current.managed = true;
        }
        current.terminal = terminalExecutionState(message) ?? current.terminal;
    }
    spans.push(current);
    const states: SessionExecutionState[] = [];
    for (const [spanIndex, span] of spans.entries()) {
        const end = spans[spanIndex + 1]?.start ?? messages.length;
        let state: SessionExecutionState;
        if (span.terminal !== null) {
            state = span.terminal;
        } else if (end < messages.length || (!sessionWorking && !span.managed)) {
            // A later execution started, or the conversation is idle and Morty never
            // ran this one: history imported from the Agent carries no lifecycle outcome.
            state = { kind: "ended" };
        } else {
            state = { kind: "open" };
        }
        for (let index = span.start; index < end; index += 1) {
            states.push(state);
        }
    }
    return states;
}

export function completedTurnNotice(completion: PromptCompletion): string | null {
    switch (completion.kind) {
        case "steered":
            return null;
        case "cancelled":
            return "Turn stopped.";
        case "ended":
            return endedTurnNotice(completion.stopReason);
        default:
            return completion satisfies never;
    }
}

/** The notice for a turn the Agent ended with its own stop reason. */
function endedTurnNotice(stopReason: string): string | null {
    switch (stopReason) {
        case "end_turn":
            return null;
        case "max_tokens":
            return "The response reached its length limit.";
        case "max_turn_requests":
            return "The agent reached its request limit for this turn.";
        case "refusal":
            return "The agent declined this request.";
        default:
            return "The response stopped before completing.";
    }
}
