import { createHash } from "node:crypto";
import type { ExternalContentStore } from "../../src/engine/session/content/external-content-store.ts";

export class UnretainedExternalContentStore implements ExternalContentStore {
    readonly put: ExternalContentStore["put"] = async ({ bytes, signal }) => {
        signal.throwIfAborted();
        return { byteLength: bytes.byteLength, key: createHash("sha256").update(bytes).digest("hex") };
    };

    readonly holds: ExternalContentStore["holds"] = async () => false;
    readonly resolve: ExternalContentStore["resolve"] = (_sessionId, _request, signal) => {
        signal.throwIfAborted();
        return Promise.resolve(null);
    };

    readonly read: ExternalContentStore["read"] = (_sessionId, _request, signal) => {
        signal.throwIfAborted();
        return Promise.resolve(null);
    };
}
