import * as v from "valibot";
import type { CloudBindings } from "../../contracts/cloud-bindings.ts";
import { computerBootstrap } from "../../contracts/computer-bootstrap.ts";
import { ComputerManagementError, relayIdentifier } from "../../contracts/computer-management.ts";
import { computerNotFound } from "../../contracts/management-error.ts";
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
    readonly #owns: (id: string) => boolean;
    readonly #endAccess: IdentityOperations["commitAccessEnd"];
    readonly #credentialKey: IdentityOperations["credentialKey"];
    readonly #runtime: (computerId: string) => ComputerBackendService;
    readonly #database: () => DurableObjectDatabase;
    readonly #account: Pick<DurableComputerAccount, "isActive">;
    /** Commits access changes with their connection checks inside the owning object. */
    constructor(
        owns: (id: string) => boolean,
        endAccess: IdentityOperations["commitAccessEnd"],
        credentialKey: IdentityOperations["credentialKey"],
        runtime: (computerId: string) => ComputerBackendService,
        database: () => DurableObjectDatabase,
        account: Pick<DurableComputerAccount, "isActive">,
    ) {
        this.#owns = owns;
        this.#endAccess = endAccess;
        this.#credentialKey = credentialKey;
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

    readonly #application = async (
        computerId: string,
        env: CloudBindings,
        signal: AbortSignal,
    ): Promise<ApplicationContext> => {
        if (!(await this.#account.isActive(signal))) {
            throw computerNotFound();
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
