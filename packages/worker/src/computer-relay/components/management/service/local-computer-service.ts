import type {
    AgentSettingsDiscoverCommandRouting,
    ComputerDiagnosticsRequestRouting,
    ComputerPingCommandRouting,
    NativeSessionTarget,
    SessionAccessHolder,
    SessionCreateCommandRouting,
} from "@morty-build/client/protocol";
import * as v from "valibot";
import { ComputerManagementError, relayIdentifier } from "../../../../contracts/computer-management.ts";
import type { ComputerPairing } from "../../../../contracts/computer-pairing.ts";
import { isHttpError } from "../../../../contracts/http-error.ts";
import { RequestDeadline } from "../../../../http/request-deadline.ts";
import type { ComputerBackendService } from "../../computer/service/computer-backend-service.ts";
import type { ClientControlCommand } from "../../runtime/service/computer-control-registry.ts";

/** Application use cases call the services in their own ComputerRelay, not an HTTP client or another Worker. */
export class LocalComputerService {
    readonly #origin: unknown;
    readonly computer: ComputerBackendService;
    constructor(origin: unknown, computer: ComputerBackendService) {
        this.#origin = origin;
        this.computer = computer;
    }

    readonly configuration = () => {
        const origin = v.parse(v.string(), this.#origin);
        const endpoint = new URL(origin);
        if (
            endpoint.origin !== origin ||
            !(
                endpoint.protocol === "https:" ||
                (endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))
            )
        ) {
            throw new ComputerManagementError("RELAY_UNAVAILABLE", "Morty origin is not configured.", 503);
        }
        return { origin };
    };

    readonly #run = async <T>(
        computerId: string,
        parent: AbortSignal,
        operation: (computer: ComputerBackendService, signal: AbortSignal) => Promise<T>,
        timeout = 120_000,
    ): Promise<T> => {
        const selected = v.parse(relayIdentifier, computerId);
        if (this.computer.computerId !== selected) {
            throw new ComputerManagementError("NOT_FOUND", "The selected computer is unavailable.", 404);
        }
        using deadline = new RequestDeadline(parent, timeout);
        const signal = deadline.signal;
        try {
            signal.throwIfAborted();
            return await operation(this.computer, signal);
        } catch (cause) {
            parent.throwIfAborted();
            if (deadline.signal.aborted) {
                throw new ComputerManagementError("RELAY_TIMEOUT", "Morty did not respond in time.", 504, { cause });
            }
            if (cause instanceof ComputerManagementError || isHttpError(cause)) {
                throw cause;
            }
            throw new ComputerManagementError("RELAY_UNAVAILABLE", "Morty could not complete Computer setup.", 502, {
                cause,
            });
        }
    };

    readonly createPairing = async (computerId: string, key: string, signal: AbortSignal) => ({
        ...(await this.#run(computerId, signal, (computer, signal) => computer.createPairing(key, signal), 15_000)),
        relayUrl: this.configuration().origin,
    });
    readonly readPairing = async (computerId: string, signal: AbortSignal) =>
        await this.#run(computerId, signal, (computer, signal) => computer.readPairing(signal), 15_000);
    readonly readComputerPairing = async (computerId: string, signal: AbortSignal): Promise<ComputerPairing> => {
        try {
            const pairing = await this.readPairing(computerId, signal);
            switch (pairing.status) {
                case "paired":
                    return "paired";
                case "revoked":
                    return "revoked";
                default:
                    return "unpaired";
            }
        } catch (cause) {
            if (isHttpError(cause) && cause.toHttpJson().body.error.code === "pairing_not_found") {
                return "unpaired";
            }
            throw cause;
        }
    };
    readonly chatComputers = async (computerId: string, signal: AbortSignal) => {
        const computers = await this.#run(computerId, signal, (computer, signal) => computer.computers(signal), 15_000);
        return computers.map(({ computerId, computerName, online, agents }) => ({
            computerId,
            computerName,
            online,
            agents: agents.map(({ harness, label }) => ({ harness, label })),
        }));
    };
    readonly getChatComputerAgents = async (computerId: string, signal: AbortSignal) =>
        await this.#run(computerId, signal, (computer, signal) => computer.agents(signal), 15_000);
    readonly readComputerDiagnostics = async (
        computerId: string,
        command: ComputerDiagnosticsRequestRouting,
        signal: AbortSignal,
    ) => await this.#run(computerId, signal, (computer, signal) => computer.clientControl(command, signal), 10_000);
    readonly measureComputerLatency = async (
        computerId: string,
        command: ComputerPingCommandRouting,
        signal: AbortSignal,
    ) =>
        await this.#run(
            computerId,
            signal,
            async (computer, signal) => {
                const started = performance.now();
                const reply = await computer.clientControl(command, signal);
                const computerLatencyMs = Math.max(0, Math.round(performance.now() - started));
                if (reply.kind !== "computer.pong" || reply.requestId !== command.requestId) {
                    throw new ComputerManagementError(
                        "RELAY_INVALID_RESPONSE",
                        "Morty returned an invalid Computer response.",
                        502,
                    );
                }
                return { computerLatencyMs, reply };
            },
            15_000,
        );
    /** Sends a client's command to the Computer and returns its reply. */
    readonly clientControl = async (computerId: string, command: ClientControlCommand, signal: AbortSignal) =>
        await this.#run(computerId, signal, (computer, signal) => computer.clientControl(command, signal));
    readonly discoverChatAgentSettings = async (
        computerId: string,
        command: AgentSettingsDiscoverCommandRouting,
        signal: AbortSignal,
    ) => await this.#run(computerId, signal, (computer, signal) => computer.settings(command, signal));
    readonly createChatSession = async (
        computerId: string,
        command: SessionCreateCommandRouting,
        lifetime: number,
        holder: SessionAccessHolder,
        signal: AbortSignal,
    ) =>
        await this.#run(computerId, signal, async (computer, signal) => {
            const ready = await computer.clientControl(command, signal);
            if (ready.kind === "session.operation.failed") {
                return ready;
            }
            if (ready.kind !== "session.ready" || ready.target.harness !== command.harness) {
                throw new ComputerManagementError(
                    "RELAY_INVALID_RESPONSE",
                    "The Computer returned an invalid Session route.",
                    502,
                );
            }
            return {
                ...(await computer.issueSessionAccess(ready.target, lifetime, holder, signal)),
                computerId,
                target: ready.target,
                ready,
            };
        });
    readonly nativeSessionAccess = async (
        computerId: string,
        target: NativeSessionTarget,
        lifetime: number,
        holder: SessionAccessHolder,
        signal: AbortSignal,
    ) =>
        await this.#run(computerId, signal, async (computer, signal) =>
            computer.issueSessionAccess(target, lifetime, holder, signal),
        );
}
