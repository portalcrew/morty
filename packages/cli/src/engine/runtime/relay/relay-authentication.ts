import { COMPUTER_SUCCESSOR_CREDENTIAL_HEADER } from "@portalcrew/morty-client/protocol";
import type { HeldComputerCredentials } from "../connection/computer-credentials.ts";

export function relayCredentialHeaders(credentials: HeldComputerCredentials): Readonly<Record<string, string>> {
    return {
        authorization: `Bearer ${credentials.current}`,
        ...(credentials.successor === null ? {} : { [COMPUTER_SUCCESSOR_CREDENTIAL_HEADER]: credentials.successor }),
    };
}

export function relayHttpEndpoint(relayUrl: URL): URL {
    const endpoint = new URL(relayUrl);
    endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
    endpoint.search = "";
    return endpoint;
}
