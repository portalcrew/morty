import type { SessionAccessGrant, SessionAccessHolder } from "@portalcrew/morty-client/protocol";
import { ComputerManagementError } from "../../../../contracts/computer-management.ts";
import { ComputerAuthenticationError } from "../../../../contracts/relay/computer-authentication.ts";
import { validateIdentifier } from "../../../../contracts/relay/pairing.ts";
import type { AccessStanding } from "../../../../contracts/relay-changes.ts";
import type { ComputerRelayStore } from "../storage/computer-relay-store.ts";
import type { IdentityStorage } from "../storage/identity-storage.ts";

/**
 * Rechecks the holder's access at the execution boundary, including for live connections. The object holds exactly one
 * computer, which its storage refuses to serve before it was created, so a request naming another one is refused.
 */
export class ComputerAccessService {
    readonly #computerId: string;
    readonly #store: Pick<ComputerRelayStore, "readActiveGeneration">;
    readonly #identities: Pick<IdentityStorage, "holdsAccess" | "accessStanding">;

    constructor(
        computerId: string,
        store: Pick<ComputerRelayStore, "readActiveGeneration">,
        identities: Pick<IdentityStorage, "holdsAccess" | "accessStanding">,
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

    readonly activeGeneration = async (signal: AbortSignal): Promise<number | null> =>
        await this.#store.readActiveGeneration(signal);

    readonly authorizeComputer = (computerId: string): void => {
        this.#own(computerId);
    };

    readonly currentSessionGeneration = async (
        computerId: string,
        holder: SessionAccessHolder,
        signal: AbortSignal,
    ): Promise<number | null> => {
        this.#own(computerId);
        const [holds, generation] = await Promise.all([
            this.holdsAccess(holder, signal),
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

    /** Whether `holder` still holds access to this computer, whatever its pairing. */
    readonly holdsAccess = async (holder: SessionAccessHolder, signal: AbortSignal): Promise<boolean> =>
        await this.#identities.holdsAccess(holder, Date.now(), signal);

    readonly accessStanding = async (holder: SessionAccessHolder, signal: AbortSignal): Promise<AccessStanding> =>
        await this.#identities.accessStanding(holder, Date.now(), signal);
}
