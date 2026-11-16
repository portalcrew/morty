import { PairingDirectoryError } from "../contracts/relay/pairing.ts";
import { readBearerToken } from "./request-headers.ts";

export function bearerToken(request: Request): string {
    const token = readBearerToken(request.headers);
    if (token === undefined) {
        throw new PairingDirectoryError("unauthorized", "A bearer token is required");
    }
    return token;
}
