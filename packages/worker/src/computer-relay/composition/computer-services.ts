import * as v from "valibot";
import type { CloudBindings } from "../../contracts/cloud-bindings.ts";
import { computerCreation } from "../../contracts/computer-creation.ts";
import { ComputerManagementError, relayIdentifier } from "../../contracts/computer-management.ts";
import type { ComputerBackendService } from "../components/computer/service/computer-backend-service.ts";
import type { IdentityOperations } from "../components/management/service/identity-operations.ts";
import { createComputer } from "../components/management/service/management-service.ts";
import { IdentityStorage } from "../components/management/storage/identity-storage.ts";
import type { DurableObjectDatabase } from "../infra/durable-object-database.ts";
import { type ApplicationContext, createApplicationDependencies } from "./application-context.ts";

/**
 * One computer's storage. Only the computer's creation binds the object and creates its schema; a request for a computer
 * the object does not hold leaves no storage behind.
 */
export class ComputerServices {
    readonly #owns: (id: string) => boolean;
    readonly #endAccess: IdentityOperations["commitAccessEnd"];
    readonly #credentialKey: IdentityOperations["credentialKey"];
    readonly #runtime: (computerId: string) => ComputerBackendService;
    readonly #database: () => DurableObjectDatabase;
    readonly #commitCreation: <Value>(write: (database: DurableObjectDatabase) => Value) => Value;
    /** Commits access changes with their connection checks inside the owning object. */
    constructor(
        owns: (id: string) => boolean,
        endAccess: IdentityOperations["commitAccessEnd"],
        credentialKey: IdentityOperations["credentialKey"],
        runtime: (computerId: string) => ComputerBackendService,
        database: () => DurableObjectDatabase,
        commitCreation: <Value>(write: (database: DurableObjectDatabase) => Value) => Value,
    ) {
        this.#owns = owns;
        this.#endAccess = endAccess;
        this.#credentialKey = credentialKey;
        this.#runtime = runtime;
        this.#database = database;
        this.#commitCreation = commitCreation;
    }

    /** The computer this object holds; a request naming another is refused with the answer every boundary gives. */
    readonly #own = (computerId: string): string => {
        const validated = v.parse(relayIdentifier, computerId);
        if (!this.#owns(validated)) {
            throw new ComputerManagementError("computer_id_mismatch", "The computer is unavailable", 421);
        }
        return validated;
    };

    readonly forComputer = (computerId: string, env: CloudBindings): ApplicationContext =>
        this.#application(this.#own(computerId), env);

    /** Creates the computer `computerId` names with its owner, who is answered; a replacement may be repeated. */
    readonly create = async (computerId: string, input: unknown, signal: AbortSignal) => {
        signal.throwIfAborted();
        const owned = this.#own(computerId);
        const { origin } = v.parse(computerCreation, input);
        return await createComputer(
            this.#credentialKey,
            (tokenHash) =>
                this.#commitCreation((database) => new IdentityStorage(database, owned).createOwner(tokenHash)),
            owned,
            origin,
            signal,
        );
    };

    /** The computer's storage refuses a computer the object does not hold, before any service reads it. */
    readonly #application = (computerId: string, env: CloudBindings): ApplicationContext =>
        createApplicationDependencies({
            bindings: env,
            computer: this.#runtime(computerId),
            identity: { computerId },
            identities: new IdentityStorage(this.#database(), computerId),
            identityOperations: { commitAccessEnd: this.#endAccess, credentialKey: this.#credentialKey },
        });
}
