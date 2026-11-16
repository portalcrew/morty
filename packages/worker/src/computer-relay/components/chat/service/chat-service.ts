import { nativeSessionKey } from "@portalcrew/morty-client/native-session";
import type {
    AgentSettingsDiscoverCommandRouting,
    ComputerDiagnosticsRequestRouting,
    ComputerPingCommandRouting,
    NativeSessionCommandRouting,
    NativeSessionTarget,
    SessionAccessHolder,
    SessionArchiveCommandRouting,
    SessionCreateCommandRouting,
    SessionListCommandRouting,
    SessionPrepareCommandRouting,
    SessionPreviewHistoryPageLoadRouting,
    SessionRestoreCommandRouting,
    WorkspaceListCommandRouting,
} from "@portalcrew/morty-client/protocol";
import { ComputerManagementError } from "../../../../contracts/computer-management.ts";
import { computerRevoked } from "../../../../contracts/computer-pairing.ts";
import type { ComputerIdentity } from "../../management/entity/computer-identity.ts";
import type { LocalComputerService } from "../../management/service/local-computer-service.ts";
import type { ManagedSessionOperations } from "../infra/managed-session-operations.ts";

const OPENED_SESSION_CREDENTIAL_SECONDS = 900;
const RENEWED_SESSION_CREDENTIAL_SECONDS = 600;

export const MINIMUM_SESSION_CREDENTIAL_SECONDS = 60;

/**
 * A Session credential lasts `usualSeconds`, but no longer than the access that requests it, so it ends when that
 * access expires. Access that ends sooner than the shortest credential is refused before issuing.
 */
function sessionCredentialLifetime(usualSeconds: number, accessExpiresAt: number | null): number {
    if (accessExpiresAt === null) {
        return usualSeconds;
    }
    const remainingSeconds = Math.floor((accessExpiresAt - Date.now()) / 1000);
    return Math.max(MINIMUM_SESSION_CREDENTIAL_SECONDS, Math.min(usualSeconds, remainingSeconds));
}

export type ChatScope = {
    readonly accessExpiresAt: number | null;
    readonly holder: SessionAccessHolder;
    readonly computerId: string;
    readonly signal: AbortSignal;
};

async function scopedNativeForkOperationId(computerId: string, key: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${computerId}\u0000${key}`));
    return `chat_${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Morty's Sessions on a computer are the Sessions its Computer holds: the Computer alone says which exist, and the cloud
 * keeps no list of its own. A computer has one owner, whom every authorized scope acts as, so each Session the Computer
 * holds is the scope's.
 */
export class ChatService {
    readonly #computerId: string;
    readonly #relay: LocalComputerService;
    readonly #sessionOperations: ManagedSessionOperations;

    constructor(cx: {
        readonly sessionOperations: ManagedSessionOperations;
        readonly services: { readonly computers: LocalComputerService };
        readonly identity: ComputerIdentity;
    }) {
        this.#computerId = cx.identity.computerId;
        this.#relay = cx.services.computers;
        this.#sessionOperations = cx.sessionOperations;
    }

    readonly authorize = async (
        requester: {
            readonly computerId: string;
            readonly accessExpiresAt: number | null;
            readonly holder: SessionAccessHolder;
        },
        computerId: string,
        signal: AbortSignal,
    ): Promise<ChatScope> => {
        const { accessExpiresAt, holder } = requester;
        signal.throwIfAborted();
        if (requester.computerId !== computerId || this.#computerId !== computerId) {
            throw new ComputerManagementError("NOT_FOUND", "Your Morty data was not found.", 404);
        }
        return { accessExpiresAt, holder, computerId, signal };
    };

    readonly computerConfiguration = async (scope: ChatScope) => {
        await this.#requirePairedComputer(scope);
        return {
            computer: await this.#relay.getChatComputerAgents(scope.signal),
        };
    };

    readonly daemonDiagnostics = async (scope: ChatScope, command: ComputerDiagnosticsRequestRouting) => {
        await this.#requirePairedComputer(scope);
        return await this.#relay.readComputerDiagnostics(command, scope.signal);
    };

    readonly networkDiagnostic = async (scope: ChatScope, command: ComputerPingCommandRouting) => {
        await this.#requirePairedComputer(scope);
        return await this.#relay.measureComputerLatency(command, scope.signal);
    };

    readonly setupComputers = async (scope: ChatScope) => ({
        computers: await this.#relay.chatComputers(scope.signal),
    });

    readonly listDirectory = async (scope: ChatScope, command: WorkspaceListCommandRouting) => {
        await this.#requirePairedComputer(scope);
        return await this.#relay.clientControl(command, scope.signal);
    };

    /**
     * Requires the Computer to have a paired Runtime, as the Relay records it. Until it has one the Computer needs an
     * Agent connected; once its Computer was revoked it needs setup run again.
     */
    readonly #requirePairedComputer = async (scope: ChatScope): Promise<void> => {
        const pairing = await this.#relay.readComputerPairing(scope.signal);
        switch (pairing) {
            case "paired":
                return;
            case "unpaired":
                throw new ComputerManagementError("AGENT_REQUIRED", "Connect an Agent to this Computer first.", 409);
            case "revoked":
                throw computerRevoked();
            default:
                return pairing satisfies never;
        }
    };

    /**
     * Runs an operation on an existing Session after every earlier one on that Session has finished, so archival cannot
     * overtake a reopen that has already found the Session.
     */
    readonly #withSession = <Result>(
        scope: ChatScope,
        target: NativeSessionTarget,
        operation: () => Promise<Result>,
    ): Promise<Result> => this.#sessionOperations.run(nativeSessionKey(target), scope.signal, operation);

    readonly #requireComputerAgent = async (scope: ChatScope, harness: string) => {
        const computer = await this.#relay.getChatComputerAgents(scope.signal);
        if (!computer.agents.some((agent) => agent.harness === harness)) {
            throw new ComputerManagementError(
                "AGENT_UNAVAILABLE",
                "Choose an agent provided by this Computer's Runtime.",
                409,
            );
        }
    };

    readonly managedSessions = async (scope: ChatScope, command: SessionListCommandRouting) => {
        await this.#requirePairedComputer(scope);
        return await this.#relay.clientControl(command, scope.signal);
    };

    readonly agentSettings = async (scope: ChatScope, command: AgentSettingsDiscoverCommandRouting) => {
        await this.#requirePairedComputer(scope);
        await this.#requireComputerAgent(scope, command.harness);
        return await this.#relay.discoverChatAgentSettings(command, scope.signal);
    };

    readonly openChat = async (scope: ChatScope, command: SessionCreateCommandRouting) => {
        await this.#requirePairedComputer(scope);
        await this.#requireComputerAgent(scope, command.harness);
        return await this.#relay.createChatSession(
            command,
            sessionCredentialLifetime(OPENED_SESSION_CREDENTIAL_SECONDS, scope.accessExpiresAt),
            scope.holder,
            scope.signal,
        );
    };

    readonly nativeSessionAccess = async (scope: ChatScope, command: SessionPrepareCommandRouting) => {
        await this.#requirePairedComputer(scope);
        return await this.#withSession(scope, command.target, async () => {
            const ready = await this.#relay.clientControl(command, scope.signal);
            if (ready.kind === "session.operation.failed") {
                return ready;
            }
            return await this.#relay.nativeSessionAccess(
                command.target,
                sessionCredentialLifetime(RENEWED_SESSION_CREDENTIAL_SECONDS, scope.accessExpiresAt),
                scope.holder,
                scope.signal,
            );
        });
    };

    readonly managedSession = async (scope: ChatScope, command: SessionRestoreCommandRouting) => {
        return await this.#withSession(scope, command.target, async () => {
            await this.#requirePairedComputer(scope);
            return await this.#relay.clientControl(command, scope.signal);
        });
    };

    /**
     * Archives the Session on the Computer, which closes it and forgets it, so it leaves the list. It answers only once
     * the Computer no longer holds the Session, and fails as the Computer does otherwise, so a Session the Computer still
     * holds stays listed. Archiving a Session the Computer does not hold succeeds.
     */
    readonly archiveManagedSession = async (scope: ChatScope, command: SessionArchiveCommandRouting) => {
        await this.#requirePairedComputer(scope);
        return await this.#withSession(
            scope,
            command.target,
            async () => await this.#relay.clientControl(command, scope.signal),
        );
    };

    readonly nativeSessions = async (
        scope: ChatScope,
        input: Extract<NativeSessionCommandRouting, { readonly action: "list" }>,
    ) => {
        await this.#requirePairedComputer(scope);
        return await this.#relay.clientControl(input, scope.signal);
    };

    readonly continueNativeSession = async (
        scope: ChatScope,
        input: Extract<NativeSessionCommandRouting, { readonly action: "find" | "import" }>,
    ) => {
        const computer =
            (await this.#relay.readComputerPairing(scope.signal)) === "paired"
                ? await this.#relay.getChatComputerAgents(scope.signal)
                : undefined;
        const agent = computer?.agents.find((item) => item.harness === input.target.harness);
        if (computer === undefined || agent === undefined) {
            throw new ComputerManagementError("HARNESS_UNAVAILABLE", "The handoff harness is unavailable.", 409);
        }
        return await this.#relay.clientControl(input, scope.signal);
    };

    readonly previewNativeSession = async (
        scope: ChatScope,
        sessionId: string,
        input: SessionPreviewHistoryPageLoadRouting,
    ) => {
        await this.#requirePairedComputer(scope);
        if (input.target.sessionId !== sessionId) {
            throw new ComputerManagementError(
                "INVALID_REQUEST",
                "The requested Session does not match the route.",
                400,
            );
        }
        return await this.#relay.clientControl(input, scope.signal);
    };

    readonly importNativeSession = async (
        scope: ChatScope,
        sessionId: string,
        input: Extract<NativeSessionCommandRouting, { readonly action: "import" }>,
    ) => {
        await this.#requirePairedComputer(scope);
        if (input.target.sessionId !== sessionId) {
            throw new ComputerManagementError(
                "INVALID_REQUEST",
                "The requested Session does not match the route.",
                400,
            );
        }
        return await this.#relay.clientControl(input, scope.signal);
    };

    readonly recoverableNativeFork = async (
        scope: ChatScope,
        operationId: string,
        input: Extract<NativeSessionCommandRouting, { readonly action: "fork" }>,
    ) => {
        await this.#requirePairedComputer(scope);
        const scopedOperationId = await scopedNativeForkOperationId(scope.computerId, `fork\u0000${operationId}`);
        if (input.requestId !== scopedOperationId) {
            throw new ComputerManagementError("INVALID_REQUEST", "The fork operation does not match the route.", 400);
        }
        return await this.#relay.clientControl(input, scope.signal);
    };

    readonly verifyAgent = async (scope: ChatScope, command: AgentSettingsDiscoverCommandRouting) => {
        await this.#requireComputerAgent(scope, command.harness);
        return await this.#relay.discoverChatAgentSettings(command, scope.signal);
    };
}
