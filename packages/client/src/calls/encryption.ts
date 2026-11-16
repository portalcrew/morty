import { z } from "zod";
import { isIdentifier } from "../protocol/shared/identifier.ts";

/** Local setup supplies this Computer-scoped capability without exposing it to the relay. */
const computerEncryptionAccessFields = {
    computerId: z.string().refine(isIdentifier),
    computerE2EPublicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/u),
    computerE2EAccessSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
};
const computerEncryptionAccessReadSchema = z.object(computerEncryptionAccessFields).readonly();
const computerEncryptionAccessWriteSchema = z.strictObject(computerEncryptionAccessFields).readonly();

export const computerEncryptionAccessCodec = {
    decode: (encoded: string) => computerEncryptionAccessReadSchema.parse(JSON.parse(encoded)),
    encode: (value: unknown): string => JSON.stringify(computerEncryptionAccessWriteSchema.parse(value)),
};
