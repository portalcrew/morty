import { randomUUID } from "node:crypto";
import { NativeSessionMap } from "@morty-build/client/native-session";
import type {
    NativeSessionTarget,
    SessionEvent,
    SessionEventPayload,
    SessionLiveEvent,
} from "@morty-build/client/protocol";
import type { ProjectedToolCall } from "../../acp/tool-call-projection.ts";
import type { SessionEventCacheTable } from "../../storage/session/session-event-cache-table.ts";
import type { SessionLiveEventPosition } from "./live-event-positions.ts";
import { type MaterializedEventsResolver, SessionEventHistoryProjection } from "./session-event-history-projection.ts";
import { SessionEventIdAllocator } from "./session-event-id-allocator.ts";

const HOT_EVENT_HIGH_WATER_MARK = 256;
const HOT_EVENT_RETENTION = 128;

class ProjectedSessionEvent {
    #event: SessionEvent;

    constructor(event: SessionEvent) {
        this.#event = event;
    }

    get event(): SessionEvent {
        return this.#event;
    }

    readonly replaceEvent = (event: SessionEvent): void => {
        this.#event = event;
    };
}

/**
 * Projected history for one Session generation.
 *
 * The projected order lives entirely in the {@link SessionEvents.#eventIds}
 * metadata array; event payloads are only materialized while they sit inside
 * the retention window or have been adopted back for a merge. Dropped payloads
 * are served from the cache database and written back after merges.
 */
class SessionEvents {
    #throughPosition = "0";
    readonly #eventIds: string[] = [];
    readonly #eventIndexById = new Map<string, number>();
    readonly #cachedItemsByEventId = new Map<string, ProjectedSessionEvent>();
    readonly #projection: SessionEventHistoryProjection;
    readonly sessionGenerationId: string;

    constructor(sessionGenerationId: string) {
        this.sessionGenerationId = sessionGenerationId;
        this.#projection = new SessionEventHistoryProjection();
    }

    readonly apply = (event: SessionLiveEvent, resolve: MaterializedEventsResolver): void => {
        const projected = this.#projection.apply(event, resolve);
        this.#throughPosition = event.position;
        if (projected.kind === "skip") {
            return;
        }
        if (projected.kind === "replace") {
            const current = this.#cachedItemsByEventId.get(projected.replacedEventId);
            if (current === undefined) {
                throw new Error("The projected Session event is unavailable");
            }
            current.replaceEvent(projected.event);
            return;
        }
        for (const projectedEvent of projected.events) {
            const item = new ProjectedSessionEvent(projectedEvent);
            this.#eventIndexById.set(projectedEvent.eventId, this.#eventIds.length);
            this.#cachedItemsByEventId.set(projectedEvent.eventId, item);
            this.#eventIds.push(projectedEvent.eventId);
        }
    };

    get throughPosition(): string {
        return this.#throughPosition;
    }

    get materializedCount(): number {
        return this.#cachedItemsByEventId.size;
    }

    /** The projected tool call for this identifier, materializing it if needed. */
    readonly toolCall = (toolCallId: string, resolve: MaterializedEventsResolver): ProjectedToolCall | undefined =>
        this.#projection.getToolCall(toolCallId, resolve);

    readonly endIndex = (cursor: string | null): number => {
        if (cursor === null) {
            return this.#eventIds.length;
        }
        const index = this.#eventIndexById.get(cursor);
        if (index === undefined) {
            throw new Error("The native event cursor is invalid");
        }
        return index;
    };

    readonly cursorAt = (index: number): string => {
        const cursor = this.#eventIds[index];
        if (cursor === undefined) {
            throw new Error("The native event cursor is unavailable");
        }
        return cursor;
    };

    readonly item = (eventId: string): SessionEvent | undefined => this.#cachedItemsByEventId.get(eventId)?.event;

    /**
     * Materializes an event that was previously dropped to the cache database.
     * Its payload stays materialized until the next flush persists the merged
     * form and drops it again.
     */
    readonly adopt = (event: SessionEvent): boolean => {
        if (!this.#eventIndexById.has(event.eventId) || this.#cachedItemsByEventId.has(event.eventId)) {
            return false;
        }
        this.#cachedItemsByEventId.set(event.eventId, new ProjectedSessionEvent(event));
        return true;
    };

    /**
     * Fills the ordinal-keyed merge view with materialized events, overriding
     * stale persisted rows for the same ordinals.
     */
    readonly eventsInRange = (startIndex: number, endIndex: number, into: Map<number, SessionEvent>): void => {
        for (let index = startIndex; index < endIndex; index += 1) {
            const eventId = this.#eventIds[index];
            if (eventId === undefined) {
                throw new Error("The projected Session event is unavailable");
            }
            const item = this.#cachedItemsByEventId.get(eventId);
            if (item !== undefined) {
                into.set(index + 1, item.event);
            }
        }
    };

    /**
     * Collects the materialized events that fall outside the retention window,
     * including adopted merge targets behind it, so a successful flush can
     * persist them before they are dropped.
     */
    readonly pendingDrops = (
        includeHotTail: boolean,
    ): readonly { readonly event: SessionEvent; readonly ordinal: number }[] => {
        const windowStart = includeHotTail
            ? this.#eventIds.length
            : Math.max(0, this.#eventIds.length - HOT_EVENT_RETENTION);
        const drops: { readonly event: SessionEvent; readonly ordinal: number }[] = [];
        for (const [eventId, item] of this.#cachedItemsByEventId) {
            const index = this.#eventIndexById.get(eventId);
            if (index !== undefined && index < windowStart) {
                drops.push({ event: item.event, ordinal: index + 1 });
            }
        }
        return drops;
    };

    readonly commitDrops = (drops: readonly { readonly event: SessionEvent }[]): void => {
        for (const { event } of drops) {
            this.#cachedItemsByEventId.delete(event.eventId);
        }
    };
}

type FlushSchedule =
    | { readonly kind: "closed" }
    | { readonly kind: "idle" }
    | { readonly handle: NodeJS.Immediate; readonly kind: "scheduled" };

export interface SessionEventPage {
    readonly throughPosition: string;
    readonly events: readonly SessionEvent[];
    readonly nextCursor: string | null;
    readonly sessionGenerationId: string;
}

export interface SessionEventStore {
    readonly append: (
        sessionTarget: NativeSessionTarget,
        event: SessionEventPayload,
        recordedAt?: string,
    ) => SessionLiveEvent;
    readonly close: () => void;
    /**
     * The projected tool call announced with this identifier in its current
     * merged form, or `undefined` when no such announcement is recorded.
     */
    readonly getToolCall: (sessionTarget: NativeSessionTarget, toolCallId: string) => ProjectedToolCall | undefined;
    readonly materialize: (
        sessionTarget: NativeSessionTarget,
        sessionGenerationId: string,
        events: readonly SessionEventPayload[],
    ) => void;
    readonly page: (sessionTarget: NativeSessionTarget, eventLimit: number, cursor: string | null) => SessionEventPage;
    /** The live stream boundary, including events omitted from projected history. */
    readonly livePosition: (
        sessionTarget: NativeSessionTarget,
    ) => Pick<SessionEventPage, "sessionGenerationId" | "throughPosition">;
    readonly remove: (sessionTarget: NativeSessionTarget) => void;
    readonly reset: (sessionTarget: NativeSessionTarget) => void;
}

function liveEvent(
    sessionTarget: NativeSessionTarget,
    sessionGenerationId: string,
    eventId: string,
    position: number,
    event: SessionEventPayload,
    recordedAt = new Date().toISOString(),
): SessionLiveEvent {
    return {
        eventId,
        ...event,
        position: position.toString(),
        recordedAt,
        sessionGenerationId,
        target: sessionTarget,
    };
}

function eventPage(
    session: SessionEvents,
    sessionGenerationId: string,
    endIndex: number,
    eventLimit: number,
    read: (startIndex: number, endIndex: number) => readonly SessionEvent[],
): SessionEventPage {
    const startIndex = Math.max(0, endIndex - eventLimit);
    return {
        events: read(startIndex, endIndex),
        throughPosition: session.throughPosition,
        nextCursor: startIndex === 0 ? null : session.cursorAt(startIndex),
        sessionGenerationId,
    };
}

export class MemorySessionEventStore implements SessionEventStore {
    readonly #allocatedPositionBySession = new NativeSessionMap<number>();
    readonly #events = new NativeSessionMap<SessionEvents>();
    readonly #eventIds = new SessionEventIdAllocator();

    readonly #session = (sessionTarget: NativeSessionTarget): SessionEvents => {
        const sessionGenerationId = randomUUID();
        const session = this.#events.get(sessionTarget) ?? new SessionEvents(sessionGenerationId);
        this.#events.set(sessionTarget, session);
        return session;
    };

    readonly #resolver =
        (session: SessionEvents): MaterializedEventsResolver =>
        (eventIds) => {
            const resolved = new Map<string, SessionEvent>();
            for (const eventId of eventIds) {
                const current = session.item(eventId);
                if (current !== undefined) {
                    resolved.set(eventId, current);
                }
            }
            return resolved;
        };

    readonly append = (
        sessionTarget: NativeSessionTarget,
        event: SessionEventPayload,
        recordedAt?: string,
    ): SessionLiveEvent => {
        const session = this.#session(sessionTarget);
        const allocatedPosition = this.#allocatedPositionBySession.get(sessionTarget) ?? 9_999;
        if (allocatedPosition === Number.MAX_SAFE_INTEGER) {
            throw new Error("The live Session event position allocation is exhausted");
        }
        const position = allocatedPosition + 1;
        this.#allocatedPositionBySession.set(sessionTarget, position);
        const recorded = liveEvent(
            sessionTarget,
            session.sessionGenerationId,
            this.#eventIds.allocate(sessionTarget, session.sessionGenerationId),
            position,
            event,
            recordedAt,
        );
        session.apply(recorded, this.#resolver(session));
        return recorded;
    };

    readonly close = (): void => {
        this.#allocatedPositionBySession.clear();
        this.#events.clear();
    };

    readonly getToolCall = (sessionTarget: NativeSessionTarget, toolCallId: string): ProjectedToolCall | undefined => {
        const session = this.#events.get(sessionTarget);
        return session === undefined ? undefined : session.toolCall(toolCallId, this.#resolver(session));
    };

    readonly materialize = (
        sessionTarget: NativeSessionTarget,
        sessionGenerationId: string,
        events: readonly SessionEventPayload[],
    ): void => {
        if (this.#events.get(sessionTarget)?.sessionGenerationId === sessionGenerationId) {
            return;
        }
        this.#events.set(sessionTarget, new SessionEvents(sessionGenerationId));
        for (const event of events) {
            this.append(sessionTarget, event);
        }
    };

    readonly livePosition = (
        sessionTarget: NativeSessionTarget,
    ): Pick<SessionEventPage, "sessionGenerationId" | "throughPosition"> => {
        const session = this.#session(sessionTarget);
        return { sessionGenerationId: session.sessionGenerationId, throughPosition: session.throughPosition };
    };

    readonly page = (
        sessionTarget: NativeSessionTarget,
        eventLimit: number,
        cursor: string | null,
    ): SessionEventPage => {
        const session = this.#session(sessionTarget);
        const endIndex = session.endIndex(cursor);
        return eventPage(session, session.sessionGenerationId, endIndex, eventLimit, (start, end) => {
            const merged = new Map<number, SessionEvent>();
            session.eventsInRange(start, end, merged);
            return [...merged.entries()].toSorted((left, right) => left[0] - right[0]).map(([, event]) => event);
        });
    };

    readonly remove = (sessionTarget: NativeSessionTarget): void => {
        this.#events.delete(sessionTarget);
    };

    readonly reset = (sessionTarget: NativeSessionTarget): void => {
        const sessionGenerationId = randomUUID();
        this.#events.set(sessionTarget, new SessionEvents(sessionGenerationId));
    };
}

export class CachedSessionEventStore implements SessionEventStore {
    readonly #cacheTable: SessionEventCacheTable;
    readonly #eventIds = new SessionEventIdAllocator();
    readonly #liveEventPositions: SessionLiveEventPosition;
    readonly #sessions = new NativeSessionMap<SessionEvents>();
    #flushSchedule: FlushSchedule = { kind: "idle" };

    constructor(cacheTable: SessionEventCacheTable, liveEventPositions: SessionLiveEventPosition) {
        this.#liveEventPositions = liveEventPositions;
        this.#cacheTable = cacheTable;
    }

    readonly #session = (sessionTarget: NativeSessionTarget): SessionEvents => {
        const sessionGenerationId = randomUUID();
        const session = this.#sessions.get(sessionTarget) ?? new SessionEvents(sessionGenerationId);
        this.#sessions.set(sessionTarget, session);
        return session;
    };

    readonly #resolver =
        (sessionTarget: NativeSessionTarget, session: SessionEvents): MaterializedEventsResolver =>
        (eventIds) => {
            const resolved = new Map<string, SessionEvent>();
            const missing: string[] = [];
            for (const eventId of eventIds) {
                const current = session.item(eventId);
                if (current !== undefined) {
                    resolved.set(eventId, current);
                } else {
                    missing.push(eventId);
                }
            }
            for (const [eventId, stored] of this.#cacheTable.readByEventIds(
                sessionTarget,
                session.sessionGenerationId,
                missing,
            )) {
                if (session.adopt(stored)) {
                    resolved.set(eventId, stored);
                }
            }
            return resolved;
        };

    readonly append = (
        sessionTarget: NativeSessionTarget,
        event: SessionEventPayload,
        recordedAt?: string,
    ): SessionLiveEvent => {
        if (this.#flushSchedule.kind === "closed") {
            throw new Error("The V2 Session event store is closed");
        }
        const session = this.#session(sessionTarget);
        const position = this.#liveEventPositions.allocate(sessionTarget);
        const recorded = liveEvent(
            sessionTarget,
            session.sessionGenerationId,
            this.#eventIds.allocate(sessionTarget, session.sessionGenerationId),
            position,
            event,
            recordedAt,
        );
        session.apply(recorded, this.#resolver(sessionTarget, session));
        this.#sessions.set(sessionTarget, session);
        if (session.materializedCount > HOT_EVENT_HIGH_WATER_MARK) {
            this.#scheduleFlush();
        }
        return recorded;
    };

    readonly getToolCall = (sessionTarget: NativeSessionTarget, toolCallId: string): ProjectedToolCall | undefined => {
        const session = this.#sessions.get(sessionTarget);
        return session === undefined ? undefined : session.toolCall(toolCallId, this.#resolver(sessionTarget, session));
    };

    readonly #scheduleFlush = (): void => {
        if (!this.#cacheTable.isAvailable || this.#flushSchedule.kind !== "idle") {
            return;
        }
        const handle = setImmediate(() => {
            if (this.#flushSchedule.kind !== "scheduled" || this.#flushSchedule.handle !== handle) {
                return;
            }
            this.#flushSchedule = { kind: "idle" };
            this.#flush(false);
        });
        this.#flushSchedule = { handle, kind: "scheduled" };
    };

    readonly materialize = (
        sessionTarget: NativeSessionTarget,
        sessionGenerationId: string,
        events: readonly SessionEventPayload[],
    ): void => {
        if (this.#sessions.get(sessionTarget)?.sessionGenerationId === sessionGenerationId) {
            return;
        }
        this.#deletePersisted(sessionTarget);
        this.#sessions.set(sessionTarget, new SessionEvents(sessionGenerationId));
        for (const event of events) {
            this.append(sessionTarget, event);
        }
    };

    readonly #flush = (includeHotTail: boolean): void => {
        if (!this.#cacheTable.isAvailable || this.#flushSchedule.kind === "closed") {
            return;
        }
        const batches = [...this.#sessions.entries()].flatMap(([sessionTarget, session]) => {
            const drops = session.pendingDrops(includeHotTail);
            return drops.length === 0
                ? []
                : [
                      {
                          events: drops,
                          sessionGenerationId: session.sessionGenerationId,
                          sessionTarget,
                      },
                  ];
        });
        if (batches.length === 0) {
            return;
        }
        if (this.#cacheTable.insert(batches)) {
            for (const batch of batches) {
                this.#sessions.get(batch.sessionTarget)?.commitDrops(batch.events);
            }
        }
    };

    readonly livePosition = (
        sessionTarget: NativeSessionTarget,
    ): Pick<SessionEventPage, "sessionGenerationId" | "throughPosition"> => {
        const session = this.#session(sessionTarget);
        return { sessionGenerationId: session.sessionGenerationId, throughPosition: session.throughPosition };
    };

    readonly page = (
        sessionTarget: NativeSessionTarget,
        eventLimit: number,
        cursor: string | null,
    ): SessionEventPage => {
        const session = this.#sessions.get(sessionTarget);
        const current = session ?? this.#session(sessionTarget);
        const endIndex = current.endIndex(cursor);
        return eventPage(current, current.sessionGenerationId, endIndex, eventLimit, (startIndex, endIndex) => {
            const merged = new Map<number, SessionEvent>();
            for (const { event, ordinal } of this.#cacheTable.read(
                sessionTarget,
                current.sessionGenerationId,
                startIndex + 1,
                endIndex,
            )) {
                merged.set(ordinal, event);
            }
            current.eventsInRange(startIndex, endIndex, merged);
            return [...merged.entries()].toSorted((left, right) => left[0] - right[0]).map(([, event]) => event);
        });
    };

    readonly #deletePersisted = (sessionTarget: NativeSessionTarget, sessionGenerationId?: string): void => {
        this.#cacheTable.delete(sessionTarget, sessionGenerationId);
    };

    readonly remove = (sessionTarget: NativeSessionTarget): void => {
        this.#deletePersisted(sessionTarget);
        this.#sessions.delete(sessionTarget);
    };

    readonly reset = (sessionTarget: NativeSessionTarget): void => {
        const previous = this.#sessions.get(sessionTarget);
        this.#deletePersisted(sessionTarget, previous?.sessionGenerationId);
        const sessionGenerationId = randomUUID();
        this.#sessions.set(sessionTarget, new SessionEvents(sessionGenerationId));
    };

    readonly close = (): void => {
        if (this.#flushSchedule.kind === "closed") {
            return;
        }
        if (this.#flushSchedule.kind === "scheduled") {
            clearImmediate(this.#flushSchedule.handle);
        }
        this.#flushSchedule = { kind: "idle" };
        this.#flush(true);
        this.#flushSchedule = { kind: "closed" };
        this.#cacheTable.close();
        this.#sessions.clear();
    };
}
