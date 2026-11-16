import type { SessionViewerIdentity } from "../../../../contracts/session-event-subscription.ts";
import type { ComputerAccessService } from "../../management/service/computer-access-service.ts";

type Access = (computerId: string) => Pick<ComputerAccessService, "activeGeneration" | "grantsSessionCredential">;

export class ComputerCredentialService {
    readonly #access: Access;

    constructor(access: Access) {
        this.#access = access;
    }

    readonly activeGeneration = async (
        identity: { readonly computerId: string },
        signal: AbortSignal,
    ): Promise<number | null> => {
        const generation = await this.#access(identity.computerId).activeGeneration(identity.computerId, signal);
        signal.throwIfAborted();
        return generation;
    };

    readonly authorizeViewer = async (
        identity: SessionViewerIdentity,
        signal: AbortSignal,
    ): Promise<"granted" | "revoked"> =>
        (await this.#access(identity.computerId).grantsSessionCredential(identity.computerId, identity.grant, signal))
            ? "granted"
            : "revoked";
}
