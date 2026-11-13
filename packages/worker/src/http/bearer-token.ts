import { PairingDirectoryError } from "../contracts/relay/pairing.ts";

export function bearerToken(request: Request): string {
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) {
        throw new PairingDirectoryError("unauthorized", "A bearer token is required");
    }
    return authorization.slice("Bearer ".length);
}
