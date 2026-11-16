/**
 * The bearer credential an `Authorization` header carries. The scheme is case-insensitive and the credential has no
 * whitespace; anything else is no credential.
 */
export function readBearerToken(headers: Headers): string | undefined {
    return headers.get("authorization")?.match(/^Bearer ([^\s]+)$/iu)?.[1];
}
