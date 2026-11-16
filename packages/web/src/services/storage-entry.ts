import * as v from "valibot";

/** A stored value's key and its encode/decode contract; `decode` returns `null` for anything it cannot represent. */
export interface StorageEntry<T> {
    readonly key: string;
    readonly encode: (value: T) => string;
    readonly decode: (raw: string) => T | null;
}

export function scopedKey(prefix: string, ...parts: readonly string[]): string {
    return `${prefix}${parts.map((part) => encodeURIComponent(part)).join(":")}`;
}

export function jsonStorageEntry<T>(options: {
    readonly key: string;
    readonly schema: v.GenericSchema<T>;
}): StorageEntry<T> {
    return {
        key: options.key,
        encode: (value) => JSON.stringify(v.parse(options.schema, value)),
        decode: (raw) => {
            try {
                const parsed = v.safeParse(options.schema, JSON.parse(raw));
                return parsed.success ? parsed.output : null;
            } catch {
                return null;
            }
        },
    };
}

export function stringStorageEntry(options: {
    readonly key: string;
    readonly schema: v.GenericSchema<string>;
}): StorageEntry<string> {
    return {
        key: options.key,
        encode: (value) => v.parse(options.schema, value),
        decode: (raw) => {
            const parsed = v.safeParse(options.schema, raw);
            return parsed.success ? parsed.output : null;
        },
    };
}
