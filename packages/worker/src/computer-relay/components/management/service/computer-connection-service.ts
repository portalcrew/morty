import type { AgentDescriptor, VerifiedComputerAccess } from "../../../../contracts/relay/pairing.ts";
import { logger } from "../../../../infra/logger.ts";
import type { ComputerConnectionOperations } from "../../runtime/service/computer-service.ts";
import type { PairingDirectoryService } from "./pairing-directory-service.ts";

export class ComputerConnectionService {
    readonly #pairings: PairingDirectoryService;
    readonly #runtime: ComputerConnectionOperations;
    constructor(cx: {
        readonly services: {
            readonly pairings: PairingDirectoryService;
            readonly runtime: ComputerConnectionOperations;
        };
    }) {
        this.#pairings = cx.services.pairings;
        this.#runtime = cx.services.runtime;
    }
    readonly updateAgentCatalog = (
        computerId: string,
        token: string,
        successor: string | null,
        agents: readonly AgentDescriptor[],
        signal: AbortSignal,
    ) => this.#pairings.updateAgentCatalog(computerId, token, successor, agents, signal);

    /**
     * Authorizes a daemon connection, rotating its credential. A reused credential ends the Computer's access first; a
     * daemon of a Computer whose access ended is told so, so it stops instead of retrying.
     */
    readonly connectComputer = async (
        token: string,
        successor: string,
        signal: AbortSignal,
    ): Promise<
        { readonly kind: "accepted"; readonly access: VerifiedComputerAccess } | { readonly kind: "revoked" }
    > => {
        const rotation = await this.#pairings.rotateComputerCredential(token, successor, signal);
        switch (rotation.kind) {
            case "rotated":
                return { kind: "accepted", access: rotation.access };
            case "revoked":
                // Ending the Computer's access is committed before its connections are closed, so a daemon that
                // retries after the closing failed midway completes it. Closing is idempotent, and leaves the daemon
                // of a newer pairing generation alone.
                await this.#runtime.revokeComputer(rotation.access.computerId, signal);
                return { kind: "revoked" };
            case "reused":
                break;
        }
        logger.warn(
            {
                event: "computer_credential_reused",
                computerId: rotation.access.computerId,
            },
            "A retired Computer credential was presented; the Computer was revoked",
        );
        await this.#runtime.revokeComputer(rotation.access.computerId, signal);
        return { kind: "revoked" };
    };
}
