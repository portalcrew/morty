import * as v from "valibot";
import type { CloudBindings } from "../../contracts/cloud-bindings.ts";
import { computerBootstrap } from "../../contracts/computer-bootstrap.ts";
import { ComputerManagementError, relayIdentifier } from "../../contracts/computer-management.ts";
import { ManagementError } from "../../contracts/management-error.ts";
import { ManagedSessionOperations } from "../components/chat/infra/managed-session-operations.ts";
import type { ComputerBackendService } from "../components/computer/service/computer-backend-service.ts";
import type { IdentityOperations } from "../components/management/service/identity-operations.ts";
import type { DurableComputerAccount } from "../components/management/storage/durable-computer-account.ts";
import { IdentityStorage } from "../components/management/storage/identity-storage.ts";
import type { DurableObjectDatabase } from "../infra/durable-object-database.ts";
import { type ApplicationContext, createApplicationDependencies } from "./application-context.ts";

/**
 * One computer's storage. Only the computer's bootstrap binds the object and creates its schema; a request for an computer
 * the object does not hold leaves no storage behind.
 */
export class ComputerServices {
    readonly #storage: DurableObjectStorage;
    readonly #owns: (id: string) => boolean;
    readonly #endAccess: IdentityOperations["commitAccessEnd"];
    readonly #runtime: (computerId: string) => ComputerBackendService;
    readonly #database: () => DurableObjectDatabase;
    readonly #account: Pick<DurableComputerAccount, "isActive">;
    /** Commits access changes with their connection checks inside the owning object. */
    constructor(
        storage: DurableObjectStorage,
        owns: (id: string) => boolean,
        endAccess: IdentityOperations["commitAccessEnd"],
        runtime: (computerId: string) => ComputerBackendService,
        database: () => DurableObjectDatabase,
        account: Pick<DurableComputerAccount, "isActive">,
    ) {
        this.#storage = storage;
        this.#owns = owns;
        this.#endAccess = endAccess;
        this.#runtime = runtime;
        this.#database = database;
        this.#account = account;
    }

    readonly #sessionOperations = new ManagedSessionOperations();

    /** The computer this object holds; a request naming another is refused with the answer every boundary gives. */
    readonly #own = (computerId: string): string => {
        const validated = v.parse(relayIdentifier, computerId);
        if (!this.#owns(validated)) {
            throw new ComputerManagementError("computer_id_mismatch", "The computer is unavailable", 421);
        }
        return validated;
    };

    readonly forComputer = async (
        computerId: string,
        env: CloudBindings,
        signal: AbortSignal,
    ): Promise<ApplicationContext> => {
        signal.throwIfAborted();
        return await this.#application(this.#own(computerId), env, signal);
    };

    readonly bootstrap = async (input: unknown, env: CloudBindings, signal: AbortSignal) => {
        signal.throwIfAborted();
        const parsed = v.parse(computerBootstrap, input);
        const dependencies = await this.#application(this.#own(parsed.computer.computerId), env, signal);
        return await dependencies.services.management.initializeComputer(parsed.computer, signal, parsed.origin);
    };

    readonly #credentialKey = async (signal: AbortSignal): Promise<Uint8Array> => {
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
            // Independent server entropy keeps a creation key or a retired predecessor token from deriving its
            // credential offline.
            // This key survives restarts, deployment credential rotation, and retries; no bearer token is stored.
            const key = crypto.getRandomValues(new Uint8Array(32));
            await storage.put("replacement-key-v1", key);
            return key;
        });
        signal.throwIfAborted();
        return result;
    };

    readonly #application = async (
        computerId: string,
        env: CloudBindings,
        signal: AbortSignal,
    ): Promise<ApplicationContext> => {
        if (!(await this.#account.isActive(signal))) {
            throw new ManagementError("COMPUTER_NOT_FOUND", "The Morty computer does not exist.", 404);
        }
        return createApplicationDependencies({
            bindings: env,
            computer: this.#runtime(computerId),
            identity: { computerId },
            identities: new IdentityStorage(this.#database(), computerId),
            sessionOperations: this.#sessionOperations,
            identityOperations: { commitAccessEnd: this.#endAccess, credentialKey: this.#credentialKey },
        });
    };
}
