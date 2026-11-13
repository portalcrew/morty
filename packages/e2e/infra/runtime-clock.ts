import { mock } from "node:test";
import type { Page } from "playwright-core";

/** Keeps the real daemon's payload clock aligned with the browser's deterministic virtual time. */
export class RuntimeClock {
    readonly #page: Page;
    #state: "inactive" | "active" = "inactive";

    constructor(page: Page) {
        this.#page = page;
    }

    #setTime(time: number): void {
        if (this.#state === "inactive") {
            mock.timers.enable({ apis: ["Date"], now: time });
            this.#state = "active";
        } else {
            mock.timers.setTime(time);
        }
    }

    readonly install = async ({ time }: { readonly time: Date }): Promise<void> => {
        this.#setTime(time.getTime());
        await this.#page.clock.install({ time });
        // Playwright replays clock logs on navigation using real browser time. Keep Date fixed so
        // a historical Node clock cannot turn that replay into a jump back to wall-clock time.
        await this.#page.clock.setFixedTime(time);
    };

    readonly setFixedTime = async (time: Date): Promise<void> => {
        this.#setTime(time.getTime());
        await this.#page.clock.setFixedTime(time);
    };

    readonly pauseAt = async (time: Date | number): Promise<void> => {
        this.#setTime(typeof time === "number" ? time : time.getTime());
        await this.#page.clock.pauseAt(time);
        await this.#page.clock.setFixedTime(new Date(Date.now()));
    };

    readonly runFor = async (milliseconds: number): Promise<void> => {
        this.#setTime(await this.#page.evaluate(() => Date.now()));
        // Advance both clocks in lockstep, including while real network I/O runs between due browser timers.
        for (let elapsed = 0; elapsed < milliseconds; elapsed += 1000) {
            const step = Math.min(1000, milliseconds - elapsed);
            mock.timers.tick(step);
            await this.#page.clock.setFixedTime(new Date(Date.now()));
            await this.#page.clock.runFor(step);
        }
    };

    readonly fastForward = async (milliseconds: number): Promise<void> => {
        this.#setTime((await this.#page.evaluate(() => Date.now())) + milliseconds);
        await this.#page.clock.setFixedTime(new Date(Date.now()));
        await this.#page.clock.fastForward(milliseconds);
    };

    readonly close = (): void => {
        if (this.#state === "active") {
            mock.timers.reset();
            this.#state = "inactive";
        }
    };
}
