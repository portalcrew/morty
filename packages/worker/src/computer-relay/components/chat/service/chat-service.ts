import { nativeSessionKey, sameNativeSession } from "@morty-build/client/native-session";
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
} from "@morty-build/client/protocol";
import { ComputerManagementError } from "../../../../contracts/computer-management.ts";
import { computerRevoked } from "../../../../contracts/computer-pairing.ts";
import type { ComputerIdentity } from "../../management/entity/computer-identity.ts";
import type { LocalComputerService } from "../../management/service/local-computer-service.ts";
import type { ManagedSessionOperations } from "../infra/managed-session-operations.ts";

const OPENED_SESSION_CREDENTIAL_SECONDS = 900;
const RENEWED_SESSION_CREDENTIAL_SECONDS = 600;

/** The Relay issues no Session credential that lasts less than this. */
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
    /** When the requesting access ends, if it does; the Session credentials it obtains end no later. */
    readonly accessExpiresAt: number | null;
    /** Whose access the request carries; the Session credentials it obtains last only while that access holds. */
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
            computer: await this.#relay.getChatComputerAgents(scope.computerId, scope.signal),
        };
    };

    readonly daemonDiagnostics = async (scope: ChatScope, command: ComputerDiagnosticsRequestRouting) => {
        await this.#requirePairedComputer(scope);
        const result = await this.#relay.readComputerDiagnostics(scope.computerId, command, scope.signal);
        if (result.kind !== "computer.diagnostics.result") {
            throw new ComputerManagementError("RELAY_INVALID_RESPONSE", "Morty returned invalid diagnostics.", 502);
        }
        return result;
    };

    readonly networkDiagnostic = async (scope: ChatScope, command: ComputerPingCommandRouting) => {
        await this.#requirePairedComputer(scope);
        return await this.#relay.measureComputerLatency(scope.computerId, command, scope.signal);
    };

    readonly setupComputers = async (scope: ChatScope) => ({
        computers: await this.#relay.chatComputers(scope.computerId, scope.signal),
    });

    readonly listDirectory = async (scope: ChatScope, command: WorkspaceListCommandRouting) => {
        await this.#requirePairedComputer(scope);
        const listing = await this.#relay.clientControl(scope.computerId, command, scope.signal);
        if (listing.kind !== "workspace.entries" && listing.kind !== "session.operation.failed") {
            throw new ComputerManagementError("RELAY_INVALID_RESPONSE", "Morty returned an invalid directory.", 502);
        }
        return listing;
    };

    /**
     * Requires the Computer to have a paired Runtime, as the Relay records it. Until it has one the Computer needs an
     * Agent connected; once its Computer was revoked it needs setup run again.
     */
    readonly #requirePairedComputer = async (scope: ChatScope): Promise<void> => {
        const pairing = await this.#relay.readComputerPairing(scope.computerId, scope.signal);
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
        const computer = await this.#relay.getChatComputerAgents(scope.computerId, scope.signal);
        if (!computer.agents.some((agent) => agent.harness === harness)) {
            throw new ComputerManagementError(
                "AGENT_UNAVAILABLE",
                "Choose an agent provided by this Computer's Runtime.",
                409,
            );
        }
    };

    /** The Sessions the Computer holds, most recently updated first. */
    readonly managedSessions = async (scope: ChatScope, command: SessionListCommandRouting) => {
        await this.#requirePairedComputer(scope);
        const result = await this.#relay.clientControl(scope.computerId, command, scope.signal);
        if (result.kind !== "session.listed" && result.kind !== "session.operation.failed") {
            throw new ComputerManagementError("RELAY_INVALID_RESPONSE", "Morty returned an invalid Session list.", 502);
        }
        return result;
    };

    /** The settings a new Session of this Agent starts with in the draft's directory. */
    readonly agentSettings = async (scope: ChatScope, command: AgentSettingsDiscoverCommandRouting) => {
        await this.#requirePairedComputer(scope);
        await this.#requireComputerAgent(scope, command.harness);
        return await this.#relay.discoverChatAgentSettings(scope.computerId, command, scope.signal);
    };

    readonly openChat = async (scope: ChatScope, command: SessionCreateCommandRouting) => {
        await this.#requirePairedComputer(scope);
        await this.#requireComputerAgent(scope, command.harness);
        return await this.#relay.createChatSession(
            scope.computerId,
            command,
            sessionCredentialLifetime(OPENED_SESSION_CREDENTIAL_SECONDS, scope.accessExpiresAt),
            scope.holder,
            scope.signal,
        );
    };

    /** Issues a credential for a Session the Computer holds. */
    readonly nativeSessionAccess = async (scope: ChatScope, command: SessionPrepareCommandRouting) => {
        await this.#requirePairedComputer(scope);
        return await this.#withSession(scope, command.target, async () => {
            const ready = await this.#relay.clientControl(scope.computerId, command, scope.signal);
            if (ready.kind === "session.operation.failed") {
                return ready;
            }
            if (ready.kind !== "session.ready" || !sameNativeSession(ready.target, command.target)) {
                throw new ComputerManagementError(
                    "RELAY_INVALID_RESPONSE",
                    "Morty returned an invalid Session route.",
                    502,
                );
            }
            return await this.#relay.nativeSessionAccess(
                scope.computerId,
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
            const restored = await this.#relay.clientControl(scope.computerId, command, scope.signal);
            if (restored.kind === "session.operation.failed") {
                return restored;
            }
            if (restored.kind !== "session.restored" || !sameNativeSession(restored.target, command.target)) {
                throw new ComputerManagementError(
                    "RELAY_INVALID_RESPONSE",
                    "Morty restored a different managed Session.",
                    502,
                );
            }
            return restored;
        });
    };

    /**
     * Archives the Session on the Computer, which closes it and forgets it, so it leaves the list. It answers only once
     * the Computer no longer holds the Session, and fails as the Computer does otherwise, so a Session the Computer still
     * holds stays listed. Archiving a Session the Computer does not hold succeeds.
     */
    readonly archiveManagedSession = async (scope: ChatScope, command: SessionArchiveCommandRouting) => {
        await this.#requirePairedComputer(scope);
        return await this.#withSession(scope, command.target, async () => {
            const archived = await this.#relay.clientControl(scope.computerId, command, scope.signal);
            if (archived.kind === "session.operation.failed") {
                return archived;
            }
            if (archived.kind !== "session.archived" || !sameNativeSession(archived.target, command.target)) {
                throw new ComputerManagementError("RELAY_INVALID_RESPONSE", "Morty archived a different Session.", 502);
            }
            return archived;
        });
    };

    readonly nativeSessions = async (
        scope: ChatScope,
        input: Extract<NativeSessionCommandRouting, { readonly action: "list" }>,
    ) => {
        await this.#requirePairedComputer(scope);
        const result = await this.#relay.clientControl(scope.computerId, input, scope.signal);
        if (
            result.kind !== "session.operation.failed" &&
            (result.kind !== "native.session.result" || result.action !== "list")
        ) {
            throw new ComputerManagementError(
                "RELAY_INVALID_RESPONSE",
                "The agent returned an invalid session directory.",
                502,
            );
        }
        return result;
    };

    /** Imports the native session a setup handoff names, found by its native identifier in the default workspace. */
    readonly continueNativeSession = async (
        scope: ChatScope,
        input: Extract<NativeSessionCommandRouting, { readonly action: "find" | "import" }>,
    ) => {
        const computer =
            (await this.#relay.readComputerPairing(scope.computerId, scope.signal)) === "paired"
                ? await this.#relay.getChatComputerAgents(scope.computerId, scope.signal)
                : undefined;
        const agent = computer?.agents.find((item) => item.harness === input.target.harness);
        if (computer === undefined || agent === undefined) {
            throw new ComputerManagementError("HARNESS_UNAVAILABLE", "The handoff harness is unavailable.", 409);
        }
        const result = await this.#relay.clientControl(scope.computerId, input, scope.signal);
        if (
            result.kind !== "session.operation.failed" &&
            (result.kind !== "native.session.result" ||
                result.action !== input.action ||
                (result.action === "import" && !sameNativeSession(result.target, input.target)))
        ) {
            throw new ComputerManagementError("IMPORT_UNAVAILABLE", "The original session could not be opened.", 409);
        }
        return result;
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
        const events = await this.#relay.clientControl(scope.computerId, input, scope.signal);
        if (
            events.kind !== "session.operation.failed" &&
            (events.kind !== "session.preview-history.page.loaded" || !sameNativeSession(events.target, input.target))
        ) {
            throw new ComputerManagementError(
                "RELAY_INVALID_RESPONSE",
                "Morty returned an invalid Session preview.",
                502,
            );
        }
        return events;
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
        const result = await this.#relay.clientControl(scope.computerId, input, scope.signal);
        if (
            result.kind !== "session.operation.failed" &&
            (result.kind !== "native.session.result" ||
                result.action !== "import" ||
                !sameNativeSession(result.target, input.target))
        ) {
            throw new ComputerManagementError(
                "IMPORT_UNAVAILABLE",
                "This agent cannot import the selected local session.",
                409,
            );
        }
        return result;
    };

    readonly recoverableNativeFork = async (
        scope: ChatScope,
        operationId: string,
        input: Extract<NativeSessionCommandRouting, { readonly action: "fork" }>,
    ) => {
        await this.#requirePairedComputer(scope);
        // Operation identity belongs to this Computer, regardless of which browser requests it.
        const scopedOperationId = await scopedNativeForkOperationId(scope.computerId, `fork\u0000${operationId}`);
        if (input.requestId !== scopedOperationId) {
            throw new ComputerManagementError("INVALID_REQUEST", "The fork operation does not match the route.", 400);
        }
        const result = await this.#relay.clientControl(scope.computerId, input, scope.signal);
        if (
            result.kind !== "session.operation.failed" &&
            (result.kind !== "native.session.result" ||
                result.action !== "fork" ||
                result.target.harness !== input.target.harness ||
                result.target.sessionId === input.target.sessionId)
        ) {
            throw new ComputerManagementError("RELAY_INVALID_RESPONSE", "Morty returned an invalid fork.", 502);
        }
        return result;
    };

    /**
     * Setup's check that the computer's paired Computer offers `harness` and can open its settings in the default
     * working directory. It records nothing: whether the Computer has a Runtime is the Relay's pairing.
     */
    readonly verifyAgent = async (scope: ChatScope, command: AgentSettingsDiscoverCommandRouting) => {
        await this.#requireComputerAgent(scope, command.harness);
        return await this.#relay.discoverChatAgentSettings(scope.computerId, command, scope.signal);
    };
}
