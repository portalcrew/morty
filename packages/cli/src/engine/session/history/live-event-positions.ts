import { NativeSessionMap } from "@portalcrew/morty-client/native-session";
import type { NativeSessionTarget } from "@portalcrew/morty-client/protocol";
import type { LiveEventPositionTable } from "../../storage/session/live-event-position-table.ts";

const INITIAL_POSITION = 10 ** 4;
const POSITION_RESERVATION_SIZE = 10_000;

interface PositionReservation {
    readonly next: number;
    readonly end: number;
}

export interface SessionLiveEventPosition {
    readonly allocate: (sessionTarget: NativeSessionTarget) => number;
}

export class SqliteSessionLiveEventPosition implements SessionLiveEventPosition {
    readonly #table: LiveEventPositionTable;
    readonly #reservations = new NativeSessionMap<PositionReservation>();

    constructor(table: LiveEventPositionTable) {
        this.#table = table;
    }

    readonly allocate = (sessionTarget: NativeSessionTarget): number => {
        const reservation = this.#reservations.get(sessionTarget) ?? this.#reserve(sessionTarget);
        if (reservation.next === reservation.end) {
            this.#reservations.delete(sessionTarget);
        } else {
            this.#reservations.set(sessionTarget, { next: reservation.next + 1, end: reservation.end });
        }
        return reservation.next;
    };

    // Persist the high-water mark before emitting any position in the range. A crash skips the
    // unused suffix rather than reusing positions, without a synchronous transaction per chunk.
    readonly #reserve = (sessionTarget: NativeSessionTarget): PositionReservation =>
        this.#table.transaction(() => {
            const persisted = this.#table.read(sessionTarget);
            const allocatedPosition = persisted ?? INITIAL_POSITION - 1;
            if (allocatedPosition === Number.MAX_SAFE_INTEGER) {
                throw new Error("The live Session event position allocation is exhausted");
            }
            const next = allocatedPosition + 1;
            const end = next + Math.min(POSITION_RESERVATION_SIZE - 1, Number.MAX_SAFE_INTEGER - next);
            if (persisted === undefined) {
                this.#table.insert(sessionTarget, end);
            } else {
                this.#table.update(sessionTarget, end);
            }
            return { next, end };
        });
}
