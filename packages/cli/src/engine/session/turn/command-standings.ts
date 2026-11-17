import type {
    AdmittedCommandStanding,
    CommandStanding,
    NativeSessionTarget,
    SessionLogPosition,
} from "@portalcrew/morty-client/protocol";
import type { SessionTurns } from "./session-turns.ts";

interface PositionedStanding<Standing> {
    readonly standing: Standing;
    readonly position: SessionLogPosition;
}

/**
 * Every answer the Computer gives about a command states where the command stands at a position in the Session's log.
 * A command enters the queue, starts and ends only in the same synchronous step that appends the log event recording
 * that change, and the log's high-water mark is read in the step that reads the standing. So no change a standing
 * reports lies beyond its position, and every read or live event at or after it reflects that standing or a later one.
 */
export class CommandStandings {
    readonly #turns: Pick<SessionTurns, "standing">;
    readonly #logPosition: (sessionTarget: NativeSessionTarget) => SessionLogPosition;

    constructor(
        turns: Pick<SessionTurns, "standing">,
        logPosition: (sessionTarget: NativeSessionTarget) => SessionLogPosition,
    ) {
        this.#turns = turns;
        this.#logPosition = logPosition;
    }

    readonly position = (sessionTarget: NativeSessionTarget): SessionLogPosition => this.#logPosition(sessionTarget);

    readonly standing = (commandId: string, sessionTarget: NativeSessionTarget): CommandStanding =>
        this.#turns.standing(commandId, sessionTarget);

    /** The admitted standing of a command that entered the queue, started or ended; null while it is preparing. */
    readonly admitted = (
        commandId: string,
        sessionTarget: NativeSessionTarget,
    ): PositionedStanding<AdmittedCommandStanding> | null => {
        const standing = this.standing(commandId, sessionTarget);
        switch (standing.state) {
            case "unknown":
            case "preparing":
                return null;
            case "queued":
            case "running":
            case "settled":
                return { standing, position: this.position(sessionTarget) };
            default:
                return standing satisfies never;
        }
    };
}
