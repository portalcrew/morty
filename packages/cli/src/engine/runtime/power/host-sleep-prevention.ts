import { type ChildProcess, spawn } from "node:child_process";
import type { ProcessLaunch } from "../../util/process/platform/contracts.ts";
import type { Timer } from "../../util/timer.ts";
import type { SleepPrevention, SleepPreventionHold } from "./sleep-prevention.ts";

const RELEASE_DEADLINE_MILLISECONDS = 5_000;

type InhibitorState =
    | { readonly kind: "holding"; readonly child: ChildProcess; readonly exited: Promise<void> }
    | { readonly kind: "unavailable" }
    | { readonly kind: "released" };

function launchInhibitor(launch: ProcessLaunch): ChildProcess | null {
    try {
        return spawn(launch.command, [...launch.arguments], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    } catch {
        return null;
    }
}

class InhibitorHold implements SleepPreventionHold {
    readonly #launches: readonly ProcessLaunch[];
    readonly #timer: Timer;
    readonly #unavailable: () => void;
    #state: InhibitorState;

    constructor(launches: readonly ProcessLaunch[], timer: Timer, unavailable: () => void) {
        this.#launches = launches;
        this.#timer = timer;
        this.#unavailable = unavailable;
        this.#state = this.#start(0);
    }

    /** An inhibitor that cannot start, or stops while held, gives way to the next one. */
    #start(first: number): InhibitorState {
        for (let index = first; index < this.#launches.length; index += 1) {
            const launch = this.#launches[index];
            const child = launch === undefined ? null : launchInhibitor(launch);
            if (child === null) {
                continue;
            }
            child.stdin?.on("error", () => undefined);
            const exited = new Promise<void>((resolve) => {
                child.once("exit", () => resolve());
                // Kill reports a failure as another error event, which must never go unhandled.
                child.on("error", () => resolve());
            });
            void exited.then(() => {
                if (this.#state.kind === "holding" && this.#state.child === child) {
                    this.#state = this.#start(index + 1);
                }
            });
            return { kind: "holding", child, exited };
        }
        this.#unavailable();
        return { kind: "unavailable" };
    }

    readonly release = async (): Promise<void> => {
        const state = this.#state;
        this.#state = { kind: "released" };
        if (state.kind !== "holding") {
            return;
        }
        state.child.stdin?.end();
        state.child.kill();
        const deadline = Promise.withResolvers<void>();
        const escalation = this.#timer.schedule(() => {
            state.child.kill("SIGKILL");
            deadline.resolve();
        }, RELEASE_DEADLINE_MILLISECONDS);
        try {
            await Promise.race([state.exited, deadline.promise]);
        } finally {
            escalation.cancel();
        }
    };
}

/**
 * Holds the computer awake through the first of the platform's inhibitor commands that runs. Holding never fails:
 * a computer that cannot be held awake only risks sleeping, so the work it would have protected still runs.
 */
export function hostSleepPrevention(launches: readonly ProcessLaunch[], timer: Timer): SleepPrevention {
    let reported = false;
    const unavailable = (): void => {
        if (!reported) {
            reported = true;
            console.error("Morty could not keep this computer awake. It may sleep while an Agent is working.");
        }
    };
    return { hold: () => new InhibitorHold(launches, timer, unavailable) };
}
