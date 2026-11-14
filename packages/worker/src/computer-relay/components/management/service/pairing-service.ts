import { ComputerSummary } from "../../../../contracts/relay/computer-status.ts";
import { PairingDirectoryError } from "../../../../contracts/relay/pairing.ts";
import type { ComputerConnectionOperations } from "../../runtime/service/computer-service.ts";
import type { PairingDirectoryService } from "./pairing-directory-service.ts";

export class PairingService {
    readonly #runtime: ComputerConnectionOperations;
    readonly #pairings: PairingDirectoryService;

    constructor(cx: {
        readonly services: {
            readonly pairings: PairingDirectoryService;
            readonly runtime: ComputerConnectionOperations;
        };
    }) {
        this.#runtime = cx.services.runtime;
        this.#pairings = cx.services.pairings;
    }

    readonly listComputers = async (computerId: string, signal: AbortSignal) => {
        const channels = await this.#pairings.listComputers(computerId, signal);
        return await Promise.all(
            channels.map(async (channel) => new ComputerSummary(channel, await this.#runtime.readStatus(signal))),
        );
    };

    readonly getComputerAgents = async (computerId: string, signal: AbortSignal) => {
        const channels = await this.#pairings.listComputers(computerId, signal);
        const channel = channels.find((candidate) => candidate.computerId === computerId);
        if (channel === undefined) {
            // A revoked Computer is not listed; saying so lets it be paired again instead of waiting for it.
            if (await this.#pairings.isComputerRevoked(computerId, signal)) {
                throw new PairingDirectoryError("computer_revoked", "The Computer has been revoked");
            }
            throw new PairingDirectoryError("computer_access_denied", "This credential cannot access this Computer");
        }
        return new ComputerSummary(channel, await this.#runtime.readStatus(signal));
    };
}
