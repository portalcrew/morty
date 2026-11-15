import * as v from "valibot";

/**
 * The computer's own server key, from which every credential a retry must reproduce is derived: replacement and
 * redemption credentials and pairing codes. It survives restarts, deployment credential rotation and retries, so a
 * retry derives what the request it repeats derived; no bearer token is stored.
 */
export class DurableCredentialKey {
    readonly #storage: DurableObjectStorage;

    constructor(storage: DurableObjectStorage) {
        this.#storage = storage;
    }

    readonly read = async (signal: AbortSignal): Promise<Uint8Array> => {
        signal.throwIfAborted();
        const result = await this.#storage.transaction(async (storage) => {
            // The stored name predates created identities; renaming it would change credentials a retry derives.
            const stored: unknown = await storage.get("replacement-key-v1");
            signal.throwIfAborted();
            if (stored !== undefined) {
                return v.parse(
                    v.pipe(
                        v.instance(Uint8Array),
                        v.check((key) => key.length === 32),
                    ),
                    stored,
                );
            }
            // Independent server entropy keeps a retired predecessor token, a redemption key or a pairing request's
            // idempotency key from deriving its credential offline.
            const key = crypto.getRandomValues(new Uint8Array(32));
            await storage.put("replacement-key-v1", key);
            return key;
        });
        signal.throwIfAborted();
        return result;
    };
}
