import type { SessionAccessGrant, SessionAccessHolder } from "@morty-build/client/protocol";
import { ComputerManagementError } from "../../../../contracts/computer-management.ts";
import { ComputerAuthenticationError } from "../../../../contracts/relay/computer-authentication.ts";
import { validateIdentifier } from "../../../../contracts/relay/pairing.ts";
import type { ComputerRelayStore } from "../storage/computer-relay-store.ts";
import type { IdentityStorage } from "../storage/identity-storage.ts";

/**
 * Rechecks the holder's access at the execution boundary, including for live connections. The object holds exactly one
 * computer, which its storage refuses to serve before it was created, so a request naming another one is refused.
 */
export class ComputerAccessService {
    readonly #computerId: string;
    readonly #store: Pick<ComputerRelayStore, "readActiveGeneration">;
    readonly #identities: Pick<IdentityStorage, "holdsAccess">;

    constructor(
        computerId: string,
        store: Pick<ComputerRelayStore, "readActiveGeneration">,
        identities: Pick<IdentityStorage, "holdsAccess">,
    ) {
        this.#computerId = computerId;
        this.#store = store;
        this.#identities = identities;
    }

    readonly #own = (computerId: string): string => {
        if (validateIdentifier(computerId, "computer_id") !== this.#computerId) {
            throw new ComputerManagementError("computer_id_mismatch", "The computer is unavailable", 421);
        }
        return computerId;
    };

    /** The pairing generation whose daemon may act for the computer now; null while none may. */
    readonly activeGeneration = async (computerId: string, signal: AbortSignal): Promise<number | null> => {
        this.#own(computerId);
        return await this.#store.readActiveGeneration(signal);
    };

    /** Refuses a request naming a computer other than the one this object holds. */
    readonly authorizeComputer = (computerId: string): void => {
        this.#own(computerId);
    };

    /** The active pairing under which the holder can receive a Session credential. */
    readonly currentSessionGeneration = async (
        computerId: string,
        holder: SessionAccessHolder,
        signal: AbortSignal,
    ): Promise<number | null> => {
        this.#own(computerId);
        const [holds, generation] = await Promise.all([
            this.#holdsAccess(holder, signal),
            this.#store.readActiveGeneration(signal),
        ]);
        return holds ? generation : null;
    };

    readonly authorizeSession = async (
        computerId: string,
        grant: SessionAccessGrant,
        signal: AbortSignal,
    ): Promise<void> => {
        const generation = await this.currentSessionGeneration(computerId, grant.holder, signal);
        if (generation !== grant.generation) {
            throw new ComputerAuthenticationError("credential_revoked", "The Session credential has been revoked");
        }
    };

    readonly grantsSessionCredential = async (
        computerId: string,
        grant: SessionAccessGrant,
        signal: AbortSignal,
    ): Promise<boolean> => {
        try {
            await this.authorizeSession(computerId, grant, signal);
            return true;
        } catch (cause) {
            if (cause instanceof ComputerAuthenticationError) {
                return false;
            }
            throw cause;
        }
    };

    /** Whether `holder`'s access to the computer holds now; a Session credential is honored only while it does. */
    readonly #holdsAccess = async (holder: SessionAccessHolder, signal: AbortSignal): Promise<boolean> =>
        await this.#identities.holdsAccess(holder, Date.now(), signal);
}
