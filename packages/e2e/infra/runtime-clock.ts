import { mock } from "node:test";
import { test } from "@playwright/test";
import type { Page, WebSocket } from "playwright-core";

/**
 * Whether the test holds the page's transport. A live transport is answered by real I/O, so virtual time waits for
 * its replies; a held one is stalled by the test on purpose, so virtual time advances through its deadlines.
 */
type Transport = "live" | "held";

/**
 * A page `/transport` socket as the browser reports it. The transport opens a socket only to send on it, so a socket
 * that has sent nothing is still opening. Each awaited exchange maps its key to a description for diagnostics.
 */
type TransportSocket =
    | { readonly kind: "opening"; readonly url: string }
    | { readonly kind: "open"; readonly url: string; readonly awaiting: ReadonlyMap<string, string> }
    | { readonly kind: "closed"; readonly url: string };

function frame(payload: string | Buffer): Readonly<Record<string, unknown>> | null {
    if (typeof payload !== "string") {
        return null;
    }
    try {
        const value: unknown = JSON.parse(payload);
        return value !== null && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value))
            : null;
    } catch {
        return null;
    }
}

function field(message: Readonly<Record<string, unknown>>, name: string): string {
    const value = message[name];
    return typeof value === "string" ? value : "";
}

function without(awaiting: ReadonlyMap<string, string>, key: string): ReadonlyMap<string, string> {
    const remaining = new Map(awaiting);
    remaining.delete(key);
    return remaining;
}

function afterSent(
    awaiting: ReadonlyMap<string, string>,
    message: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, string> {
    switch (field(message, "kind")) {
        case "http.request":
            return new Map(awaiting).set(
                `request ${field(message, "requestId")}`,
                `${field(message, "method")} ${field(message, "path")}`,
            );
        case "http.cancel":
            return without(awaiting, `request ${field(message, "requestId")}`);
        case "session.events.subscribe":
            return new Map(awaiting).set(
                `subscription ${field(message, "subscriptionId")}`,
                `subscribe ${field(message, "path")}`,
            );
        case "session.events.unsubscribe":
            return without(awaiting, `subscription ${field(message, "subscriptionId")}`);
        case "ping":
            return new Map(awaiting).set("ping", "heartbeat ping");
        default:
            return awaiting;
    }
}

function afterReceived(
    awaiting: ReadonlyMap<string, string>,
    message: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, string> {
    switch (field(message, "kind")) {
        case "http.response":
        case "http.error":
            return without(awaiting, `request ${field(message, "requestId")}`);
        case "session.events.ready":
        case "session.events.error":
        case "session.events.end":
            return without(awaiting, `subscription ${field(message, "subscriptionId")}`);
        case "pong":
            return without(awaiting, "ping");
        default:
            return awaiting;
    }
}

function sent(socket: TransportSocket, payload: string | Buffer): TransportSocket {
    if (socket.kind === "closed") {
        return socket;
    }
    const awaiting = socket.kind === "open" ? socket.awaiting : new Map<string, string>();
    const message = frame(payload);
    return { kind: "open", url: socket.url, awaiting: message === null ? awaiting : afterSent(awaiting, message) };
}

function received(socket: TransportSocket, payload: string | Buffer): TransportSocket {
    const message = frame(payload);
    return socket.kind !== "open" || message === null
        ? socket
        : { ...socket, awaiting: afterReceived(socket.awaiting, message) };
}

function describe(state: TransportSocket): readonly string[] {
    switch (state.kind) {
        case "opening":
            return [`opening ${state.url}`];
        case "open":
            return [...state.awaiting.values()].map((description) => `${description} on ${state.url}`);
        case "closed":
            return [];
    }
}

/**
 * The exchanges real I/O has yet to answer. The page's transport opens a new socket to a Computer only after it has
 * failed every exchange on the previous one, so only the newest socket per endpoint can still be awaited.
 */
function awaiting(sockets: ReadonlyMap<WebSocket, TransportSocket>, held: ReadonlySet<WebSocket>): readonly string[] {
    const newest = new Map<string, WebSocket>();
    for (const [socket, state] of sockets) {
        newest.set(state.url, socket);
    }
    return [...newest.values()].flatMap((socket) => {
        const state = sockets.get(socket);
        return state === undefined || held.has(socket) ? [] : describe(state);
    });
}

/**
 * Keeps the real daemon's payload clock aligned with the browser's deterministic virtual time. The page's transport
 * deadlines are virtual-time timers while its replies travel over real I/O, so virtual time advances only while the
 * page awaits no transport reply; otherwise a fast loop expires deadlines that real I/O was about to meet.
 */
export class RuntimeClock {
    readonly #page: Page;
    #state: "inactive" | "active" = "inactive";
    readonly #sockets = new Map<WebSocket, TransportSocket>();
    readonly #held = new Set<WebSocket>();
    #change = Promise.withResolvers<void>();

    constructor(page: Page) {
        this.#page = page;
        // Only the Morty transport: the page's HTTP long polls stay open by design.
        page.on("websocket", (socket) => {
            const url = socket.url();
            if (!new URL(url).pathname.endsWith("/transport")) {
                return;
            }
            const update = (next: (current: TransportSocket) => TransportSocket): void => {
                const current = this.#sockets.get(socket);
                if (current !== undefined) {
                    this.#sockets.set(socket, next(current));
                }
                this.#notify();
            };
            this.#sockets.set(socket, { kind: "opening", url });
            this.#notify();
            socket.on("framesent", ({ payload }) => update((current) => sent(current, payload)));
            socket.on("framereceived", ({ payload }) => update((current) => received(current, payload)));
            socket.on("socketerror", () => update((current) => ({ kind: "closed", url: current.url })));
            socket.on("close", () => update((current) => ({ kind: "closed", url: current.url })));
        });
    }

    readonly #notify = (): void => {
        this.#change.resolve();
        this.#change = Promise.withResolvers();
    };

    /** A real-time bound for one clock operation: the action timeout every other wait in a test gets. */
    #deadline(): AbortSignal {
        return AbortSignal.timeout(test.info().project.use.actionTimeout ?? 30_000);
    }

    /** Waits, without polling, until the page awaits no transport reply that real I/O will deliver. */
    readonly #settle = async (transport: Transport, deadline: AbortSignal): Promise<void> => {
        while (transport === "live") {
            const pending = awaiting(this.#sockets, this.#held);
            if (pending.length === 0) {
                return;
            }
            await this.#nextChange(deadline, pending);
        }
    };

    readonly #nextChange = async (deadline: AbortSignal, pending: readonly string[]): Promise<void> => {
        const expired = Promise.withResolvers<never>();
        const expire = (): void =>
            expired.reject(new Error(`Virtual time is still waiting on the page's transport: ${pending.join("; ")}`));
        if (deadline.aborted) {
            expire();
        }
        deadline.addEventListener("abort", expire, { once: true });
        try {
            await Promise.race([this.#change.promise, expired.promise]);
        } finally {
            deadline.removeEventListener("abort", expire);
        }
    };

    #setTime(time: number): void {
        if (this.#state === "inactive") {
            mock.timers.enable({ apis: ["Date"], now: time });
            this.#state = "active";
        } else {
            mock.timers.setTime(time);
        }
    }

    /** Advances both clocks in lockstep by at most one second, so a due browser timer runs at its own time. */
    readonly #step = async (milliseconds: number): Promise<void> => {
        mock.timers.tick(milliseconds);
        await this.#page.clock.setFixedTime(new Date(Date.now()));
        await this.#page.clock.runFor(milliseconds);
    };

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

    readonly holdOpenTransports = (): void => {
        for (const [socket, state] of this.#sockets) {
            if (state.kind !== "closed") {
                this.#held.add(socket);
            }
        }
        this.#notify();
    };

    readonly runFor = async (
        milliseconds: number,
        { transport = "live" }: { readonly transport?: Transport } = {},
    ): Promise<void> => {
        const deadline = this.#deadline();
        this.#setTime(await this.#page.evaluate(() => Date.now()));
        for (let elapsed = 0; elapsed < milliseconds; elapsed += 1000) {
            await this.#settle(transport, deadline);
            await this.#step(Math.min(1000, milliseconds - elapsed));
        }
    };

    /**
     * Advances virtual time as `runFor` does until `assertion` passes, or until it settles when it is a promise, within
     * `maximum` milliseconds of virtual time. While the page awaits a reply it re-checks on each transport frame
     * instead. An assertion must not retry on its own, since it runs again whenever time or the transport moves.
     */
    readonly advanceUntil = async (
        assertion: Promise<unknown> | (() => unknown),
        { transport = "live", maximum = 300_000 }: { readonly transport?: Transport; readonly maximum?: number } = {},
    ): Promise<void> => {
        const deadline = this.#deadline();
        let settled = false;
        if (typeof assertion !== "function") {
            const settle = (): void => {
                settled = true;
                this.#notify();
            };
            void assertion.then(settle, settle);
        }
        const check = async (): Promise<unknown> => {
            if (typeof assertion !== "function") {
                return settled ? null : new Error("The awaited promise has not settled");
            }
            try {
                await assertion();
                return null;
            } catch (failure) {
                return failure;
            }
        };
        this.#setTime(await this.#page.evaluate(() => Date.now()));
        let advanced = 0;
        for (let failure = await check(); failure !== null; failure = await check()) {
            const pending = transport === "live" ? awaiting(this.#sockets, this.#held) : [];
            if (pending.length > 0) {
                await this.#nextChange(deadline, pending);
                continue;
            }
            if (advanced >= maximum || deadline.aborted) {
                throw new Error(`The assertion still failed after ${advanced} ms of virtual time`, { cause: failure });
            }
            await this.#step(1000);
            advanced += 1000;
        }
        if (typeof assertion !== "function") {
            await assertion;
        }
    };

    readonly fastForward = async (milliseconds: number): Promise<void> => {
        await this.#settle("live", this.#deadline());
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
