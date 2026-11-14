import type {
    AgentSettingsDiscoverCommandRouting,
    NativeSessionTarget,
    SessionAccessHolder,
} from "@morty-build/client/protocol";
import { hashSecret, PairingDirectoryError } from "../../../../contracts/relay/pairing.ts";
import type { RelayContext } from "../../../composition/relay-services.ts";
import type { ClientControlCommand } from "../../runtime/service/computer-control-registry.ts";
import type { LocalSessionOperations } from "../../runtime/service/local-session-operations.ts";
import type { SessionAccessService } from "../../runtime/service/session-access-service.ts";

/** Only constructed inside the ComputerRelay that owns these Computer operations. */
export class ComputerBackendService {
    readonly computerId: string;
    readonly #context: RelayContext;
    readonly #sessionAccess: SessionAccessService;
    readonly #pairingRoot: string;
    private readonly operations: LocalSessionOperations;
    constructor(
        computerId: string,
        context: RelayContext,
        sessionAccess: SessionAccessService,
        pairingRoot: string,
        operations: LocalSessionOperations,
    ) {
        this.computerId = computerId;
        this.#context = context;
        this.#sessionAccess = sessionAccess;
        this.#pairingRoot = pairingRoot;
        this.operations = operations;
    }

    // Pairing retries derive the same code without storing or transporting a service credential.
    readonly createPairing = async (idempotencyKey: string, signal: AbortSignal) =>
        await this.#context.services.pairings.createComputerPairing(
            this.computerId,
            await hashSecret(`morty.internal.pairing.v1:${this.#pairingRoot}`),
            idempotencyKey,
            signal,
        );
    readonly readPairing = async (signal: AbortSignal) =>
        await this.#context.services.pairings.readComputerPairing(this.computerId, signal);
    readonly computers = async (signal: AbortSignal) =>
        await this.#context.services.computerPairings.listComputers(this.computerId, signal);
    readonly agents = async (signal: AbortSignal) =>
        await this.#context.services.computerPairings.getComputerAgents(this.computerId, signal);
    readonly issueSessionAccess = async (
        target: NativeSessionTarget,
        lifetime: number,
        holder: SessionAccessHolder,
        signal: AbortSignal,
    ) => await this.#sessionAccess.issue({ computerId: this.computerId, target }, lifetime, holder, signal);
    readonly clientControl = async (command: ClientControlCommand, signal: AbortSignal) => {
        const access = await this.#context.services.pairings.authorizeComputer(this.computerId, signal);
        return await this.operations.requestClientControl(access.computerId, command, signal);
    };
    readonly settings = async (command: AgentSettingsDiscoverCommandRouting, signal: AbortSignal) => {
        const computers = await this.#context.services.pairings.listComputers(this.computerId, signal);
        if (!computers.some((computer) => computer.computerId === this.computerId)) {
            throw new PairingDirectoryError("computer_access_denied", "This credential cannot access this Computer");
        }
        const access = await this.#context.services.pairings.authorizeComputer(this.computerId, signal);
        return await this.operations.requestAgentSettings(access.computerId, command, signal);
    };
}
