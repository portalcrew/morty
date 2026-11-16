const ACCOUNT_KEY = "computer-account";

/**
 * Whether this object holds a computer: the one fact every request checks before it reaches the computer's storage.
 * Which computer it is belongs to the object's name, which `ComputerRelay` checks against every request, so the account
 * records only that one was created. Only the computer's creation records it, in the transaction that stores its owner.
 */
export class DurableComputerAccount {
    readonly #storage: DurableObjectStorage;

    constructor(storage: DurableObjectStorage) {
        this.#storage = storage;
    }

    /** Only a computer that exists gets a database: a request naming one that does not must leave none behind. */
    readonly holdsAccount = (): boolean => this.#storage.kv.get(ACCOUNT_KEY) !== undefined;

    readonly create = (): void => {
        this.#storage.kv.put(ACCOUNT_KEY, true);
    };
}
