import type { AcpSessionUpdate, SessionEvent, SessionLiveEvent } from "@morty-build/client/protocol";

type AcpSessionEvent = Extract<SessionEvent, { readonly type: "acp" }>;
type ToolCall = Extract<AcpSessionUpdate, { readonly sessionUpdate: "tool_call" | "tool_call_update" }>;
/** A tool call's merged fields: patched fields are never null, and an announcement adds the title it requires. */
type ToolCallFields = Omit<Extract<ToolCall, { readonly sessionUpdate: "tool_call" }>, "sessionUpdate" | "title"> & {
    readonly title?: string;
};
type Reasoning = Extract<AcpSessionUpdate, { readonly sessionUpdate: "agent_thought_chunk" }>;

const MAXIMUM_PROJECTED_REASONING_BYTES = 24 * 1024;
const MAXIMUM_PROJECTED_MESSAGE_CHARACTERS = 1_000_000;

function boundReasoning(payload: Reasoning): Reasoning {
    if (
        payload.content.type !== "text" ||
        Buffer.byteLength(payload.content.text, "utf8") <= MAXIMUM_PROJECTED_REASONING_BYTES
    ) {
        return payload;
    }
    const bytes = Buffer.from(payload.content.text, "utf8");
    let start = bytes.length - MAXIMUM_PROJECTED_REASONING_BYTES;
    // Retain a UTF-8 tail without starting inside a code point.
    while (start < bytes.length && (bytes.readUInt8(start) & 0xc0) === 0x80) {
        start += 1;
    }
    return {
        ...payload,
        content: { ...payload.content, text: bytes.toString("utf8", start) },
        meta: { ...payload.meta, truncated: true },
    };
}

type LifecycleSessionEvent = Extract<SessionEvent, { readonly type: "lifecycle-metadata" }>;

export type SessionEventHistoryProjectionMutation =
    | { readonly kind: "skip" }
    | { readonly events: readonly SessionEvent[]; readonly kind: "append" }
    | { readonly event: SessionEvent; readonly kind: "replace"; readonly replacedEventId: string };

/**
 * Resolves the current projected payloads of events by their identifiers, in
 * batch. The resolver materializes events whose payloads are no longer held in
 * memory, so merge targets can live on a slower tier.
 */
export type MaterializedEventsResolver = (eventIds: readonly string[]) => ReadonlyMap<string, SessionEvent>;

function projectNewEvent(
    liveEvent: Extract<SessionLiveEvent, { readonly type: "acp" }>,
    eventId: string,
): AcpSessionEvent {
    // History states the Session and generation once, on its page; the live event's own copies stay behind.
    const {
        position: _position,
        eventId: _liveEventId,
        sessionGenerationId: _generation,
        target: _target,
        ...event
    } = liveEvent;
    if (event.type === "acp" && event.payload.sessionUpdate === "agent_thought_chunk") {
        return { ...event, eventId, payload: boundReasoning(event.payload) };
    }
    return { ...event, eventId };
}

function projectLifecycleEvent(
    liveEvent: Extract<SessionLiveEvent, { readonly type: "lifecycle-metadata" }>,
): LifecycleSessionEvent {
    const { position: _position, sessionGenerationId: _generation, target: _target, ...event } = liveEvent;
    return event;
}

function replaceAcpPayload(event: AcpSessionEvent, payload: AcpSessionUpdate): AcpSessionEvent {
    return { ...event, payload };
}

/**
 * ACP v1 treats omission and `null` as equivalent on a tool call update:
 * both leave the previously reported value unchanged. There is no way to
 * clear a field once it has a value, so an update only contributes fields
 * it actually carries.
 */
function patchToolCallFields(previous: ToolCall, incoming: ToolCall): ToolCallFields {
    const {
        sessionUpdate: _previousKind,
        content: previousContent,
        kind: previousKind,
        locations: previousLocations,
        rawInput: previousRawInput,
        rawOutput: previousRawOutput,
        status: previousStatus,
        title: previousTitle,
        ...previousFields
    } = previous;
    const {
        sessionUpdate: _incomingKind,
        content,
        kind,
        locations,
        rawInput,
        rawOutput,
        status,
        title,
        ...incomingFields
    } = incoming;
    const mergedTitle = title ?? previousTitle ?? undefined;
    return {
        ...previousFields,
        ...incomingFields,
        ...(content === undefined || content === null
            ? previousContent === undefined || previousContent === null
                ? {}
                : { content: previousContent }
            : { content }),
        ...(kind === undefined || kind === null
            ? previousKind === undefined || previousKind === null
                ? {}
                : { kind: previousKind }
            : { kind }),
        ...(locations === undefined || locations === null
            ? previousLocations === undefined || previousLocations === null
                ? {}
                : { locations: previousLocations }
            : { locations }),
        ...(rawInput === undefined || rawInput === null
            ? previousRawInput === undefined || previousRawInput === null
                ? {}
                : { rawInput: previousRawInput }
            : { rawInput }),
        ...(rawOutput === undefined || rawOutput === null
            ? previousRawOutput === undefined || previousRawOutput === null
                ? {}
                : { rawOutput: previousRawOutput }
            : { rawOutput }),
        ...(status === undefined || status === null
            ? previousStatus === undefined || previousStatus === null
                ? {}
                : { status: previousStatus }
            : { status }),
        // An update that omits the title keeps the one already reported.
        ...(mergedTitle === undefined ? {} : { title: mergedTitle }),
        toolCallId: previous.toolCallId,
    };
}

function mergeToolCall(previous: ToolCall, incoming: ToolCall): ToolCall {
    if (previous.sessionUpdate === "tool_call_update") {
        return {
            ...patchToolCallFields(previous, incoming),
            sessionUpdate: "tool_call_update",
        };
    }
    const fields = patchToolCallFields(previous, incoming);
    // A tool call always carries a title in the session event log, so the
    // merged form keeps the announced one when an update omits it.
    return { ...fields, sessionUpdate: "tool_call", title: fields.title ?? previous.title };
}

function mergeTextChunk(previous: AcpSessionUpdate, incoming: AcpSessionUpdate): AcpSessionUpdate | null {
    if (
        (previous.sessionUpdate !== "agent_message_chunk" &&
            previous.sessionUpdate !== "agent_thought_chunk" &&
            previous.sessionUpdate !== "user_message_chunk") ||
        incoming.sessionUpdate !== previous.sessionUpdate ||
        previous.messageId !== incoming.messageId ||
        previous.content.type !== "text" ||
        incoming.content.type !== "text"
    ) {
        return null;
    }
    // Keep complete, individually valid chunks when merging would exceed the wire's
    // UTF-16 string bound. Their message identity still groups them for the viewer.
    if (
        previous.sessionUpdate !== "agent_thought_chunk" &&
        previous.content.text.length + incoming.content.text.length > MAXIMUM_PROJECTED_MESSAGE_CHARACTERS
    ) {
        return null;
    }
    const content = { text: `${previous.content.text}${incoming.content.text}`, type: "text" as const };
    if (previous.sessionUpdate === "agent_thought_chunk" && incoming.sessionUpdate === "agent_thought_chunk") {
        return boundReasoning({
            ...previous,
            content,
            ...(previous.meta?.truncated === true || incoming.meta?.truncated === true
                ? { meta: { ...previous.meta, ...incoming.meta, truncated: true } }
                : {}),
        });
    }
    return { ...previous, content };
}

export class SessionEventHistoryProjection {
    readonly #toolCallEventIds = new Map<string, string>();
    /** The turns this history holds: open until their ending is recorded, where the turn ended. */
    readonly #turns = new Map<string, "open" | "ended">();
    #latestEvent: SessionEvent | null = null;

    readonly apply = (
        liveEvent: SessionLiveEvent,
        resolve: MaterializedEventsResolver,
    ): SessionEventHistoryProjectionMutation => {
        if (liveEvent.type === "lifecycle-metadata") {
            this.#latestEvent = null;
            return this.#turnLifecycle(liveEvent);
        }
        if (liveEvent.type === "acp" && liveEvent.payload.sessionUpdate === "tool_call_update") {
            const targetEventId = this.#toolCallEventIds.get(liveEvent.payload.toolCallId);
            const current = targetEventId === undefined ? undefined : resolve([targetEventId]).get(targetEventId);
            if (
                current?.type === "acp" &&
                (current.payload.sessionUpdate === "tool_call" || current.payload.sessionUpdate === "tool_call_update")
            ) {
                return this.#replace(
                    current,
                    replaceAcpPayload(current, mergeToolCall(current.payload, liveEvent.payload)),
                );
            }
            // The target cannot be materialized (for example an undecodable
            // cache row), so the update is recorded as its own event instead.
        }

        const latest = this.#latestEvent;
        if (liveEvent.type === "acp" && latest?.type === "acp") {
            const merged = mergeTextChunk(latest.payload, liveEvent.payload);
            if (merged !== null) {
                return this.#replace(latest, replaceAcpPayload(latest, merged));
            }
        }

        const event = projectNewEvent(liveEvent, liveEvent.eventId);
        this.#latestEvent = event;
        this.#indexToolCall(event);
        return { events: [event], kind: "append" };
    };

    /**
     * The projected tool call announced with this identifier, in its current
     * merged form, or `undefined` when the projection has not recorded one.
     */
    readonly getToolCall = (toolCallId: string, resolve: MaterializedEventsResolver): ToolCall | undefined => {
        const eventId = this.#toolCallEventIds.get(toolCallId);
        if (eventId === undefined) {
            return undefined;
        }
        const event = resolve([eventId]).get(eventId);
        if (
            event?.type === "acp" &&
            (event.payload.sessionUpdate === "tool_call" || event.payload.sessionUpdate === "tool_call_update")
        ) {
            return event.payload;
        }
        return undefined;
    };

    /**
     * Keeps the lifecycle that delimits each turn, where it happened. A turn's ending is history only once, after its
     * start: an ending restated for a client, or one for a turn this history does not hold, has no place in it.
     * Interaction and queue changes are current state, not history.
     */
    readonly #turnLifecycle = (
        liveEvent: Extract<SessionLiveEvent, { readonly type: "lifecycle-metadata" }>,
    ): SessionEventHistoryProjectionMutation => {
        const payload = liveEvent.payload;
        switch (payload.kind) {
            case "prompt.requested":
            case "prompt.started":
            case "prompt.delegated":
                if (this.#turns.get(payload.commandId) === "ended") {
                    return { kind: "skip" };
                }
                this.#turns.set(payload.commandId, "open");
                return { events: [projectLifecycleEvent(liveEvent)], kind: "append" };
            case "prompt.completed":
            case "prompt.failed":
            case "prompt.failed-before-start":
                if (this.#turns.get(payload.commandId) !== "open") {
                    return { kind: "skip" };
                }
                this.#turns.set(payload.commandId, "ended");
                return { events: [projectLifecycleEvent(liveEvent)], kind: "append" };
            case "session.queue.changed":
            case "session.permission.requested":
            case "session.permission.resolved":
            case "session.elicitation.requested":
            case "session.elicitation.resolved":
                return { kind: "skip" };
            default:
                return payload satisfies never;
        }
    };

    readonly #replace = (current: SessionEvent, replacement: SessionEvent): SessionEventHistoryProjectionMutation => {
        if (this.#latestEvent?.eventId === current.eventId) {
            this.#latestEvent = replacement;
        }
        this.#indexToolCall(replacement);
        return { event: replacement, kind: "replace", replacedEventId: current.eventId };
    };

    readonly #indexToolCall = (event: SessionEvent): void => {
        if (
            event.type === "acp" &&
            (event.payload.sessionUpdate === "tool_call" || event.payload.sessionUpdate === "tool_call_update")
        ) {
            this.#toolCallEventIds.set(event.payload.toolCallId, event.eventId);
        }
    };
}
