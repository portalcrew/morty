import type { z } from "zod";
import type { PayloadDecryptor, PayloadEncryptor } from "../../encryption.ts";
import { ProtocolMessageError, parseJson } from "./message-codec.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

async function encryptPrivateFields(
    value: Readonly<Record<string, unknown>>,
    publicFields: Readonly<Record<string, unknown>>,
    encryptor: PayloadEncryptor,
    signal: AbortSignal,
): Promise<string> {
    return encryptor.encrypt(
        encoder.encode(JSON.stringify(value)),
        encoder.encode(JSON.stringify(publicFields)),
        signal,
    );
}

async function decryptPrivateFields(
    ciphertext: string,
    publicFields: Readonly<Record<string, unknown>>,
    decryptor: PayloadDecryptor,
    signal: AbortSignal,
): Promise<Readonly<Record<string, unknown>>> {
    const plaintext = await decryptor.decrypt(ciphertext, encoder.encode(JSON.stringify(publicFields)), signal);
    let privateFields: Readonly<Record<string, unknown>>;
    try {
        privateFields = parseJson(decoder.decode(plaintext));
    } catch (cause) {
        throw new ProtocolMessageError("Invalid encrypted message", { cause });
    }
    return privateFields;
}

/** The message owns both schemas; only the encrypted wire mechanics are shared. */
export function encryptedMessageCodec<
    T,
    R extends { readonly kind: string; readonly encrypted: string },
    S extends z.ZodRawShape,
>(options: {
    readonly kind: R["kind"];
    readonly decode: (encoded: string) => T;
    readonly decodeRouting: (encoded: string) => R;
    readonly publicRoutingSchema: z.ZodObject<S>;
}) {
    return Object.freeze({
        kind: options.kind,
        decodeRouting: options.decodeRouting,
        encodeRouting: (message: R): string => JSON.stringify(options.decodeRouting(JSON.stringify(message))),
        encode: async (message: unknown, encryptor: PayloadEncryptor, signal: AbortSignal): Promise<string> => {
            const value = parseJson(JSON.stringify(options.decode(JSON.stringify(message))));
            const routing = parseJson(JSON.stringify(options.publicRoutingSchema.parse(value)));
            const privateFields = Object.fromEntries(
                Object.entries(value).filter(([key]) => !Object.hasOwn(options.publicRoutingSchema.shape, key)),
            );
            const encrypted = await encryptPrivateFields(privateFields, routing, encryptor, signal);
            return JSON.stringify({ ...routing, encrypted });
        },
        decode: async (encoded: string, decryptor: PayloadDecryptor, signal: AbortSignal): Promise<T> => {
            const { encrypted, ...routing } = options.decodeRouting(encoded);
            const privateFields = await decryptPrivateFields(encrypted, routing, decryptor, signal);
            if (
                Object.keys(privateFields).some(
                    (key) => key === "encrypted" || Object.hasOwn(options.publicRoutingSchema.shape, key),
                )
            ) {
                throw new ProtocolMessageError("Encrypted message duplicates a routing field");
            }
            return options.decode(JSON.stringify({ ...privateFields, ...routing }));
        },
    });
}
