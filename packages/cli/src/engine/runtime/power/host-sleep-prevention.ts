import { type ChildProcess, spawn } from "node:child_process";
import type { ProcessLaunch } from "../../util/process/platform/contracts.ts";
import type { SleepPrevention, SleepPreventionHold } from "./sleep-prevention.ts";

type InhibitorState =
    | { readonly kind: "holding"; readonly child: ChildProcess; readonly exited: Promise<void> }
    | { readonly kind: "unavailable" }
    | { readonly kind: "released" };

class InhibitorHold implements SleepPreventionHold {
    readonly #launches: readonly ProcessLaunch[];
    readonly #unavailable: () => void;
    #state: InhibitorState;

    constructor(launches: readonly ProcessLaunch[], unavailable: () => void) {
        this.#launches = launches;
        this.#unavailable = unavailable;
        this.#state = this.#start(0);
    }

    /** An inhibitor that cannot start, or stops while held, gives way to the next one. */
    #start(index: number): InhibitorState {
        const launch = this.#launches[index];
        if (launch === undefined) {
            this.#unavailable();
            return { kind: "unavailable" };
        }
        const child = spawn(launch.command, [...launch.arguments], {
            stdio: ["pipe", "ignore", "ignore"],
            windowsHide: true,
        });
        child.stdin?.on("error", () => undefined);
        const exited = new Promise<void>((resolve) => {
            child.once("exit", () => resolve());
            child.once("error", () => resolve());
        });
        void exited.then(() => {
            if (this.#state.kind === "holding" && this.#state.child === child) {
                this.#state = this.#start(index + 1);
            }
        });
        return { kind: "holding", child, exited };
    }

    readonly release = async (): Promise<void> => {
        const state = this.#state;
        this.#state = { kind: "released" };
        if (state.kind !== "holding") {
            return;
        }
        state.child.stdin?.end();
        state.child.kill();
        await state.exited;
    };
}

/** Holds the computer awake through the first of the platform's inhibitor commands that runs. */
export function hostSleepPrevention(launches: readonly ProcessLaunch[]): SleepPrevention {
    let reported = false;
    const unavailable = (): void => {
        if (!reported) {
            reported = true;
            console.error("Morty could not keep this computer awake. It may sleep while an Agent is working.");
        }
    };
    return { hold: () => new InhibitorHold(launches, unavailable) };
}
