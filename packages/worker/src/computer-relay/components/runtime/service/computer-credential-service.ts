import type { SessionViewerIdentity } from "../../../../contracts/session-event-subscription.ts";
import type { ComputerAccessService } from "../../management/service/computer-access-service.ts";

type Access = () => Pick<ComputerAccessService, "activeGeneration" | "grantsSessionCredential">;

export class ComputerCredentialService {
    readonly #computerId: string;
    readonly #access: Access;

    constructor(computerId: string, access: Access) {
        this.#computerId = computerId;
        this.#access = access;
    }

    readonly activeGeneration = async (signal: AbortSignal): Promise<number | null> => {
        const generation = await this.#access().activeGeneration(signal);
        signal.throwIfAborted();
        return generation;
    };

    readonly authorizeViewer = async (
        identity: SessionViewerIdentity,
        signal: AbortSignal,
    ): Promise<"granted" | "revoked"> =>
        (await this.#access().grantsSessionCredential(this.#computerId, identity.grant, signal))
            ? "granted"
            : "revoked";
}
