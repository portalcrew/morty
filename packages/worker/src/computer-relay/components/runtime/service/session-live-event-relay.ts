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
            if (viewer.expiresAt <= Date.now()) {
                viewer.socket.close(1000, "Session access expired");
                continue;
            }
            if (!sameNativeSession(viewer.target, routing.target)) {
                continue;
            }
            try {
                viewer.socket.send(encoded);
            } catch {
                viewer.socket.close(1013, "Session subscription backpressure");
            }
        }
    };
}
