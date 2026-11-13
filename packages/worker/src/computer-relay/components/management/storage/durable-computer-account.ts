import { waitForAccount } from "./account-operation.ts";

const ACCOUNT_KEY = "computer-account";

/**
 * Whether this object holds a computer's account. Which computer it is belongs to the object's name, which
 * `ComputerRelay` checks against every request, so the account records only that one was created.
 */
export class DurableComputerAccount {
    readonly #storage: DurableObjectStorage;

    constructor(storage: DurableObjectStorage) {
        this.#storage = storage;
    }

    readonly isActive = async (signal: AbortSignal): Promise<boolean> =>
        await waitForAccount(async () => (await this.#storage.get(ACCOUNT_KEY)) !== undefined, signal);

    /** Creates the account, or keeps the one an earlier request created. */
    readonly create = async (signal: AbortSignal): Promise<void> => {
        await waitForAccount(
            () =>
                this.#storage.transaction(async (storage) => {
                    if ((await storage.get(ACCOUNT_KEY)) !== undefined) {
                        return;
                    }
                    signal.throwIfAborted();
                    await storage.put(ACCOUNT_KEY, true);
                }),
            signal,
        );
    };
}
