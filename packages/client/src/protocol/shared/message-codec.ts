import { z } from "zod";
import { ENCRYPTED_MESSAGE_MAX_WIRE_BYTES } from "./encrypted-message-limits.ts";
import { decodeIdentifier, type Identifier } from "./identifier.ts";

export const encryptedFieldSchema = z.string().min(1).max(ENCRYPTED_MESSAGE_MAX_WIRE_BYTES);

export class ProtocolMessageError extends Error {
    readonly code = "invalid_protocol_message";

    constructor(message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.name = "ProtocolMessageError";
    }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJson(encoded: string): Readonly<Record<string, unknown>> {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (error) {
        throw new ProtocolMessageError("Message is not valid JSON", {
            cause: error,
        });
    }

    if (!isRecord(value)) {
        throw new ProtocolMessageError("Message must be a JSON object");
    }

    return value;
}

function readString(value: Readonly<Record<string, unknown>>, key: string, maximumLength: number): string {
    const field = value[key];
    if (typeof field !== "string" || field.length === 0 || field.length > maximumLength) {
        throw new ProtocolMessageError(`Invalid string field: ${key}`);
    }
    return field;
}

export function readText(value: Readonly<Record<string, unknown>>, key: string, maximumLength: number): string {
    const field = value[key];
    if (typeof field !== "string" || field.length > maximumLength) {
        throw new ProtocolMessageError(`Invalid text field: ${key}`);
    }
    return field;
}

export function readIdentifier(value: Readonly<Record<string, unknown>>, key: string): Identifier {
    try {
        return decodeIdentifier(value[key]);
    } catch (cause) {
        throw new ProtocolMessageError(`Invalid identifier field: ${key}`, { cause });
    }
}

export function assertKind(value: Readonly<Record<string, unknown>>, expectedKind: string): void {
    if (value["kind"] !== expectedKind) {
        throw new ProtocolMessageError(`Expected message kind: ${expectedKind}`);
    }
}

export function decodeMessageKind(encoded: string): string {
    return readString(parseJson(encoded), "kind", 64);
}

export function decodeZodMessage<T>(encoded: string, schema: z.ZodType<T>): T {
    const result = schema.safeParse(parseJson(encoded));
    if (!result.success) {
        throw new ProtocolMessageError("Message does not match its schema", {
            cause: result.error,
        });
    }
    return result.data;
}

export function decodeZodValue<T>(value: unknown, schema: z.ZodType<T>): T {
    const result = schema.safeParse(value);
    if (!result.success) {
        throw new ProtocolMessageError("Message field does not match its schema", {
            cause: result.error,
        });
    }
    return result.data;
}

export function encodeZodMessage<T>(message: T, schema: z.ZodType<T>): string {
    return JSON.stringify(decodeZodValue(message, schema));
}
