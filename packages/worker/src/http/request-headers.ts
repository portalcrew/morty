export function readBearerToken(request: Request): string | undefined {
    return request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/iu)?.[1];
}
