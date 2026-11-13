import type { HarnessReplyPlan } from "@morty-build/runtime-test-support/fake-daemon";
import {
    type ControlledAgentBehavior,
    connectControlledAgentRuntime,
    createMortyFakeDaemon,
} from "../../../tests/support/fake-daemon/runtime.ts";
import type { ComputerCredentials } from "../../cli/src/engine/runtime/connection/computer-credentials.ts";
import type { SetupRuntime } from "../../cli/src/setup/setup.ts";
import { memoryComputerCredentials } from "../../cli/tests/support/computer-credentials.ts";
import { jsonRequest, text } from "./chat-api.ts";

type Connection = Readonly<{
    pairingGeneration: string;
    computer_id: string;
    credential: string;
    origin: string;
}>;

/** Setup's Runtime port backed by the production daemon engine and a controlled Agent harness. */
export class ControlledSetupRuntime implements SetupRuntime {
    readonly #saved = new Map<string, Connection>();
    /** Each saved connection's relay credential, which rotates on every connection like the daemon's saved one. */
    readonly #credentials = new Map<string, ComputerCredentials>();
    readonly #active = new Map<string, Awaited<ReturnType<typeof connectControlledAgentRuntime>>>();
    readonly #failed = Promise.withResolvers<never>();
    readonly failure = this.#failed.promise;

    #options: ControlledAgentBehavior;
    readonly #computerName: string;

    constructor(options: ControlledAgentBehavior, computerName: string) {
        this.#computerName = computerName;
        this.#options = options;
        // The fixture races failures against the browser scenario; retain early failures too.
        void this.failure.catch(() => undefined);
    }

    readonly computer: SetupRuntime["computer"] = async (_directory, signal) => {
        signal.throwIfAborted();
        return Array.from(this.#saved.values(), ({ computer_id }) => computer_id).at(-1) ?? null;
    };

    readonly encryptionAccess: SetupRuntime["encryptionAccess"] = async (_directory, computerId, signal) => {
        const connection = Array.from(this.#saved.values()).find((entry) => entry.computer_id === computerId);
        const daemon = connection === undefined ? undefined : this.#active.get(connection.pairingGeneration);
        if (daemon === undefined) {
            throw new Error("The requested computer has no local Runtime");
        }
        return await daemon.encryptionAccess(signal);
    };

    readonly agents: SetupRuntime["agents"] = async (_directory, signal) => {
        signal.throwIfAborted();
        return createMortyFakeDaemon(this.#options).catalog.map(({ harness, label }) => ({
            harness,
            label,
            status: "ready",
            recoveryCommand: "",
            minimumSupportedVersion: "",
        }));
    };

    readonly start: SetupRuntime["start"] = async (_directory, signal) => {
        const connection = Array.from(this.#saved.values()).at(-1);
        if (connection === undefined) {
            throw new Error("Unknown controlled Computer connection");
        }
        await this.#connect(connection, signal);
    };

    readonly pair: SetupRuntime["pair"] = async (_directory, pairing, signal) => {
        const daemon = createMortyFakeDaemon(this.#options);
        const claim = await jsonRequest(
            pairing.relayOrigin,
            `/morty/api/v1/computers/${pairing.computerId}/pairing/redeem`,
            {
                body: {
                    agents: daemon.catalog,
                    computerName: this.#computerName,
                    pairingCode: pairing.pairingCode,
                    workspaceName: "Test project",
                },
                signal,
            },
        );
        const connection: Connection = {
            computer_id: text(claim["computerId"], "Channel ID"),
            pairingGeneration: crypto.randomUUID(),
            credential: text(claim["computerCredential"], "Computer credential"),
            origin: pairing.relayOrigin,
        };
        this.#saved.set(connection.pairingGeneration, connection);
        this.#credentials.set(connection.pairingGeneration, memoryComputerCredentials(connection.credential));
        await this.#connect(connection, signal);
    };

    /**
     * Installs other Agents on the computer. Like the manager after an install, running connections restart and
     * publish the new catalog once they reconnect; later connections offer the same Agents.
     */
    readonly installAgents = async (
        agents: Pick<ControlledAgentBehavior, "additionalAgents" | "harness" | "agentName">,
    ): Promise<void> => {
        this.#options = { ...this.#options, ...agents };
        for (const daemon of this.#active.values()) {
            await daemon.restartWithAgents(agents);
        }
    };

    /**
     * Like the manager's daemon, a connection runs in the background: the command that starts it can be cancelled,
     * but only `disconnect` stops the daemon once it runs.
     */
    async #connect(connection: Connection, signal: AbortSignal): Promise<void> {
        signal.throwIfAborted();
        if (this.#active.has(connection.pairingGeneration)) {
            return;
        }
        const daemon = await connectControlledAgentRuntime({
            behavior: this.#options,
            connection: {
                computerId: connection.computer_id,
                origin: connection.origin,
                credentials: this.#savedCredentials(connection.pairingGeneration),
            },
            signal: new AbortController().signal,
        });
        this.#active.set(connection.pairingGeneration, daemon);
        void daemon.failure.catch((error: unknown) => {
            if (this.#active.get(connection.pairingGeneration) !== daemon) {
                return;
            }
            // Like the manager's daemon, a revoked Computer stops its own connection and the others keep running.
            if (Reflect.get(Object(error), "code") === "computer_relay_revoked") {
                this.#active.delete(connection.pairingGeneration);
                return;
            }
            this.#failed.reject(error);
        });
    }

    #savedCredentials(pairingGeneration: string): ComputerCredentials {
        const credentials = this.#credentials.get(pairingGeneration);
        if (credentials === undefined) {
            throw new Error("The saved connection has no Computer credential");
        }
        return credentials;
    }

    readonly disconnect = async (): Promise<void> => {
        const active = Array.from(this.#active.values());
        this.#active.clear();
        await Promise.all(active.map((daemon) => daemon[Symbol.asyncDispose]()));
    };

    /** Restarts the production engines while keeping their persisted session directories. */
    readonly restart = async (): Promise<void> => {
        const active = Array.from(this.#active.values());
        await Promise.all(active.map((daemon) => daemon.disconnect()));
        await Promise.all(active.map((daemon) => daemon.reconnect()));
    };

    /** Disconnects the real relay while retaining the daemon's persisted sessions for recovery. */
    readonly pause = async (): Promise<void> => {
        await Promise.all(Array.from(this.#active.values(), (daemon) => daemon.disconnect()));
    };

    readonly resume = async (): Promise<void> => {
        await Promise.all(Array.from(this.#active.values(), (daemon) => daemon.reconnect()));
    };

    /** Simulates the manager forgetting every saved Computer connection. */
    readonly forgetConnections = async (): Promise<void> => {
        await this.disconnect();
        this.#saved.clear();
        this.#credentials.clear();
    };

    readonly continueReply = async (prompt: string, plan: HarnessReplyPlan): Promise<void> => {
        for (const daemon of this.#active.values()) {
            await daemon.continueReply(prompt, plan);
        }
    };

    readonly writeFiles = async (files: NonNullable<ControlledAgentBehavior["files"]>): Promise<void> => {
        for (const daemon of this.#active.values()) {
            await daemon.writeFiles(files);
        }
    };
}
