import { sameNativeSession } from "@morty-build/client/native-session";
import type { SessionEventEnvelopeRouting } from "@morty-build/client/protocol";
import type { RelayPeers } from "./computer-relay-actor.ts";

export class SessionLiveEventRelay {
    readonly #peers: RelayPeers;

    constructor(peers: RelayPeers) {
        this.#peers = peers;
    }

    readonly receive = (routing: SessionEventEnvelopeRouting, encoded: string): void => {
        for (const viewer of this.#peers.viewers()) {
            if (viewer.identity.expiresAt <= Date.now()) {
                viewer.close(1000, "Session access expired");
                continue;
            }
            if (!sameNativeSession(viewer.identity.sessionFilter, routing.target)) {
                continue;
            }
            try {
                viewer.message(encoded);
            } catch {
                viewer.close(1013, "Session subscription backpressure");
            }
        }
    };
}
