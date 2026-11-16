import type { NativeSessionTarget } from "./protocol/session/shared/native-session-target.ts";

/** A serialization for application indexes, never a caller-assigned conversation identity. */
export const nativeSessionKey = (target: NativeSessionTarget): string =>
    JSON.stringify([target.harness, target.sessionId]);

export const sameNativeSession = (left: NativeSessionTarget, right: NativeSessionTarget): boolean =>
    left.harness === right.harness && left.sessionId === right.sessionId;

export const nativeSessionTarget = ({ harness, sessionId }: NativeSessionTarget): NativeSessionTarget => ({
    harness,
    sessionId,
});

/**
 * The identity of one native fork on one Computer. The Worker accepts a fork only under the identity its operation
 * derives, so a fork repeated after a lost answer reaches the same Computer operation.
 */
export async function nativeForkRequestId(computerId: string, operationId: string): Promise<string> {
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${computerId}\u0000fork\u0000${operationId}`),
    );
    return `chat_${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Indexes state by the full native pair; the serialization never leaves this index. */
export class NativeSessionMap<Value> {
    readonly #entries = new Map<string, { readonly target: NativeSessionTarget; readonly value: Value }>();
    constructor(entries: Iterable<readonly [NativeSessionTarget, Value]> = []) {
        for (const [target, value] of entries) {
            this.set(target, value);
        }
    }
    readonly get = (target: NativeSessionTarget): Value | undefined =>
        this.#entries.get(nativeSessionKey(target))?.value;
    readonly has = (target: NativeSessionTarget): boolean => this.#entries.has(nativeSessionKey(target));
    readonly set = (target: NativeSessionTarget, value: Value): this => {
        this.#entries.set(nativeSessionKey(target), { target, value });
        return this;
    };
    readonly delete = (target: NativeSessionTarget): boolean => this.#entries.delete(nativeSessionKey(target));
    readonly clear = (): void => this.#entries.clear();
    *entries(): IterableIterator<readonly [NativeSessionTarget, Value]> {
        for (const entry of this.#entries.values()) {
            yield [entry.target, entry.value];
        }
    }
    *values(): IterableIterator<Value> {
        for (const entry of this.#entries.values()) {
            yield entry.value;
        }
    }
    [Symbol.iterator](): IterableIterator<readonly [NativeSessionTarget, Value]> {
        return this.entries();
    }
}

export class NativeSessionSet {
    readonly #entries = new NativeSessionMap<true>();
    readonly has = (target: NativeSessionTarget): boolean => this.#entries.has(target);
    readonly add = (target: NativeSessionTarget): this => {
        this.#entries.set(target, true);
        return this;
    };
    readonly delete = (target: NativeSessionTarget): boolean => this.#entries.delete(target);
    readonly clear = (): void => this.#entries.clear();
}
