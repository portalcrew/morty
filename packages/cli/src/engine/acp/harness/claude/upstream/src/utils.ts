// Modified for Morty.
// Part of the Claude ACP adapter derived from Zed Industries' claude-code-acp (Apache-2.0).

// A pushable async iterable: allows you to push items and consume them with for-await.

import type { Readable, Writable } from "node:stream";
import { ReadableStream, WritableStream } from "node:stream/web";
import type { Logger } from "./acp-agent.js";

// Useful for bridging push-based and async-iterator-based code.
export class Pushable<T> implements AsyncIterable<T> {
    private queue: T[] = [];
    private resolvers: ((value: IteratorResult<T>) => void)[] = [];
    private done = false;

    push(item: T) {
        if (this.resolvers.length > 0) {
            const resolve = this.resolvers.shift();
            if (resolve === undefined) {
                return;
            }
            resolve({ value: item, done: false });
        } else {
            this.queue.push(item);
        }
    }

    end() {
        this.done = true;
        while (this.resolvers.length > 0) {
            const resolve = this.resolvers.shift();
            resolve?.({ done: true, value: undefined });
        }
    }

    [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
            next: (): Promise<IteratorResult<T>> => {
                if (this.queue.length > 0) {
                    const value = this.queue.shift();
                    if (value === undefined) {
                        return Promise.resolve({ done: true, value: undefined });
                    }
                    return Promise.resolve({ value, done: false });
                }
                if (this.done) {
                    return Promise.resolve({ done: true, value: undefined });
                }
                return new Promise<IteratorResult<T>>((resolve) => {
                    this.resolvers.push(resolve);
                });
            },
        };
    }
}

// Helper to convert Node.js streams to Web Streams
export function nodeToWebWritable(nodeStream: Writable): WritableStream<Uint8Array> {
    return new WritableStream<Uint8Array>({
        write(chunk) {
            return new Promise<void>((resolve, reject) => {
                nodeStream.write(Buffer.from(chunk), (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });
        },
    });
}

export function nodeToWebReadable(nodeStream: Readable): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            nodeStream.on("data", (chunk: Buffer) => {
                controller.enqueue(new Uint8Array(chunk));
            });
            nodeStream.on("end", () => controller.close());
            nodeStream.on("error", (err) => controller.error(err));
        },
    });
}

export function unreachable(value: never, logger: Logger = console) {
    let valueAsString: unknown;
    try {
        valueAsString = JSON.stringify(value);
    } catch {
        valueAsString = value;
    }
    logger.error(`Unexpected case: ${valueAsString}`);
}

export function sleep(time: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, time));
}

/** Run `operation` bounded by `timeoutMilliseconds`, and by `signal` when it aborts
 *  first. The underlying SDK reads cannot be cancelled, so a deadline only stops
 *  waiting on them: a late result is discarded rather than delivered. */
export async function withDeadline<T>(
    signal: AbortSignal,
    timeoutMilliseconds: number,
    operation: () => Promise<T>,
): Promise<T> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMilliseconds)]);
    deadline.throwIfAborted();
    return await new Promise<T>((resolve, reject) => {
        const settle = (callback: () => void): void => {
            deadline.removeEventListener("abort", onAbort);
            callback();
        };
        const onAbort = (): void => settle(() => reject(deadline.reason));
        deadline.addEventListener("abort", onAbort, { once: true });

        operation().then(
            (value) => settle(() => resolve(value)),
            (error: unknown) => settle(() => reject(error)),
        );
    });
}

/** Serialises {@link withEnvironment} so two calls cannot interleave on the single
 *  `process.env` binding they share. */
let environmentChain: Promise<unknown> = Promise.resolve();

/** Run `operation` with `environment` installed as the process environment, then
 *  restore the previous one.
 *
 *  The Claude Agent SDK resolves sessions from `CLAUDE_CONFIG_DIR` and related
 *  variables it reads off `process.env`, so an Agent hosted for a workspace whose
 *  environment differs from the daemon's own still has to see that environment.
 *  This used to be done by loading the SDK inside a worker with `env` set; that
 *  worker resolved the SDK through `import.meta.resolve`, which is not shimmed
 *  when this Agent is bundled to CJS, and the SDK is inlined into that bundle so
 *  there is no module on disk for a worker to import anyway. */
export function withEnvironment<T>(environment: Readonly<NodeJS.ProcessEnv>, operation: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
        const previous = process.env;
        process.env = { ...environment } as NodeJS.ProcessEnv;
        try {
            return await operation();
        } finally {
            process.env = previous;
        }
    };
    const result = environmentChain.then(run, run);
    environmentChain = result.then(
        () => undefined,
        () => undefined,
    );
    return result;
}
