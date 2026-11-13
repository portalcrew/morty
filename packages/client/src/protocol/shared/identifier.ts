import { z } from "zod";

export const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export const identifierStringSchema = z.string().min(1).max(128).regex(IDENTIFIER_PATTERN);
export const identifierSchema = identifierStringSchema.brand<"Identifier">();

export type Identifier = z.infer<typeof identifierSchema>;

export function isIdentifier(value: unknown): value is Identifier {
    return identifierSchema.safeParse(value).success;
}

export function decodeIdentifier(value: unknown): Identifier {
    return identifierSchema.parse(value);
}
