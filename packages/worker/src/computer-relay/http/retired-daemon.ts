import { COMPUTER_SUCCESSOR_CREDENTIAL_HEADER, isComputerCredentialSuccessor } from "@portalcrew/morty-client/protocol";
import { computerIdFromPrefixedValue } from "../../contracts/computer-id.ts";
import { closedWebSocketResponse } from "../../http/closed-websocket.ts";
import { RequestDeadline } from "../../http/request-deadline.ts";
import { readBearerToken } from "../../http/request-headers.ts";

import { daemonCloseFrame } from "../components/runtime/entity/connection-ending.ts";

export const retiredPairingLookup = "https://computer.internal/__computer/retired-pairing";

export async function retiredDaemonResponse(
    request: Request,
    namespace: DurableObjectNamespace,
): Promise<Response | null> {
    const token = readBearerToken(request.headers);
    const id = computerIdFromPrefixedValue(token ?? "");
    const successor = request.headers.get(COMPUTER_SUCCESSOR_CREDENTIAL_HEADER) ?? "";
    if (id === null || token === undefined || !isComputerCredentialSuccessor(token, successor)) {
        return null;
    }
    using deadline = new RequestDeadline(request.signal, 5000);
    const oldObject = namespace.get(namespace.idFromName(id));
    const proof = await oldObject.fetch(retiredPairingLookup, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, [COMPUTER_SUCCESSOR_CREDENTIAL_HEADER]: successor },
        signal: deadline.signal,
    });
    await proof.body?.cancel();
    return proof.status === 204 ? revokedDaemonResponse() : null;
}

export function revokedDaemonResponse(): Response {
    return closedWebSocketResponse(daemonCloseFrame({ kind: "revoked" }));
}
