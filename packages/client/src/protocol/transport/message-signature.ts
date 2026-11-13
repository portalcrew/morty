import type { PayloadDecryptor, PayloadEncryptor } from "../../encryption.ts";

export function defineMessageSignature<
    const K extends string,
    C extends {
        readonly kind: K;
        readonly encode: (value: unknown, encryptor: PayloadEncryptor, signal: AbortSignal) => Promise<string>;
        readonly decode: (
            encoded: string,
            decryptor: PayloadDecryptor,
            signal: AbortSignal,
        ) => Promise<{ readonly kind: K }>;
        readonly decodeRouting: (encoded: string) => { readonly kind: K };
    },
>({ kind, codec }: { readonly kind: K; readonly codec: C }): C {
    if (kind !== codec.kind) {
        throw new Error("Message codec kind does not match its registry entry");
    }
    return codec;
}
