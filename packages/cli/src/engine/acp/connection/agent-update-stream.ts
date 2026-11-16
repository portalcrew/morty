import { setImmediate as yieldToRuntime } from "node:timers/promises";
import { AcpExecutionError } from "../acp-error.ts";
import { sessionIdSchema } from "../protocol/native-session.ts";
import type { IdentifiedSessionNotification as SessionNotification } from "./session-notification.ts";

const MAX_QUEUED_UPDATES = 2048;
const MAX_QUEUED_BYTES = 16 * 1024 * 1024;
const MAX_RUNTIME_QUEUED_BYTES = 64 * 1024 * 1024;
const UPDATES_PER_YIELD = 32;
let runtimeQueuedBytes = 0;
let updatesSinceYield = 0;

export class AgentUpdateStream {
    #tail: Promise<void> = Promise.resolve();
    #pendingUpdates = 0;
    #pendingBytes = 0;
    #state: "open" | "failed" = "open";
    readonly #consume: (notification: SessionNotification) => Promise<void>;

    constructor(consume: (notification: SessionNotification) => Promise<void>) {
        this.#consume = consume;
    }

    readonly drained = (): Promise<void> => this.#tail;

    readonly #enqueue = (notification: SessionNotification): Promise<void> => {
        if (this.#state === "failed") {
            return this.#tail;
        }
        const bytes = Buffer.byteLength(JSON.stringify(notification), "utf8");
        if (
            this.#pendingUpdates >= MAX_QUEUED_UPDATES ||
            this.#pendingBytes + bytes > MAX_QUEUED_BYTES ||
            runtimeQueuedBytes + bytes > MAX_RUNTIME_QUEUED_BYTES
        ) {
            this.#state = "failed";
            this.#tail = this.#tail.then(() => {
                throw new AcpExecutionError("The Agent output processing queue is full", {}, "agent_update_limit");
            });
            return this.#tail;
        }
        this.#pendingUpdates += 1;
        this.#pendingBytes += bytes;
        runtimeQueuedBytes += bytes;
        this.#tail = this.#tail
            .then(async () => {
                updatesSinceYield += 1;
                if (updatesSinceYield >= UPDATES_PER_YIELD) {
                    updatesSinceYield = 0;
                    await yieldToRuntime();
                }
                await this.#consume(notification);
            })
            .finally(() => {
                this.#pendingUpdates -= 1;
                this.#pendingBytes -= bytes;
                runtimeQueuedBytes -= bytes;
            })
            .catch((error: unknown) => {
                this.#state = "failed";
                throw error;
            });
        return this.#tail;
    };

    readonly receive = (notification: SessionNotification): Promise<void> => {
        sessionIdSchema.parse(notification.sessionId);
        return this.#enqueue(notification);
    };
}
