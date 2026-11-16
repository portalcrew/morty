import type { ChildProcess } from "node:child_process";
import {
    type ClientConnection,
    methods,
    ndJsonStream,
    type SessionNotification,
} from "@agentclientprotocol/sdk/unstable";
import { AcpExecutionError } from "../../../src/engine/acp/acp-error.ts";
import type { AgentTermination } from "../../../src/engine/acp/agent/agent-lifecycle.ts";
import { raceAgentOperation } from "../../../src/engine/acp/connection/agent-operation.ts";
import type { IdentifiedSessionNotification } from "../../../src/engine/acp/connection/session-notification.ts";
import {
    captureProcessTree,
    executableLaunch,
    platformSpawnOptions,
    spawnProcess,
    stopProcessTree,
} from "../../../src/engine/util/process/executable.ts";
import { createAcpClient } from "../acp/create-client.ts";
import { createWritableAcpStream, readableAcpStream } from "./acp-stream.ts";
import type { AgentConnection, AgentConnectionOptions } from "./agent-connection.ts";

interface ControlledAcpLaunch {
    readonly harness: string;
    readonly adapterPath: string;
    readonly arguments: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
}

interface ControlledAcpConnectionOptions extends AgentConnectionOptions {
    readonly maximumOutputBytes?: number;
}

// Scenarios steer the peer through MORTY_FAKE_ and MORTY_TEST_ variables of their own. Every other MORTY_ variable is
// Morty configuration of whoever runs the tests, and the peer must not see it.
const TEST_CHANNEL = /^MORTY_(FAKE|TEST)_/;

// The peer runs with the toolchain's environment (PATH, HOME, and the like) and its scenario's variables. A developer
// shell that sets MORTY_STATE_DIRECTORY therefore cannot change what a daemon scenario observes.
function peerEnvironment(agentEnvironment: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
    const inherited = Object.entries(process.env).filter(
        ([name]) => !name.startsWith("MORTY_") || TEST_CHANNEL.test(name),
    );
    return { ...Object.fromEntries(inherited), ...agentEnvironment };
}

// The SDK validates the ACP envelope; this subprocess peer also promises identified chunks.
// Validate its wire contract here, not in production harness callback delivery.
function isIdentifiedNotification(notification: SessionNotification): notification is IdentifiedSessionNotification {
    const update = notification.update;
    switch (update.sessionUpdate) {
        case "user_message_chunk":
        case "agent_message_chunk":
        case "agent_thought_chunk":
            return typeof update.messageId === "string" && update.messageId.length > 0;
        default:
            return true;
    }
}

/** Stateful controlled ACP peer transport used only by daemon integration scenarios. */
export class ControlledAcpConnection implements AgentConnection {
    readonly connection: ClientConnection;
    readonly termination: Promise<AgentTermination>;
    readonly #child: ChildProcess;
    readonly #consumeStderr: (chunk: Buffer) => void;
    #closePromise: Promise<void> | null = null;

    constructor(agent: ControlledAcpLaunch, options: ControlledAcpConnectionOptions) {
        const launch = executableLaunch(agent.adapterPath, agent.arguments);
        const child = spawnProcess(launch.command, launch.arguments, {
            cwd: options.cwd,
            ...platformSpawnOptions,
            env: peerEnvironment(agent.environment),
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.#child = child;
        const { stdin, stdout, stderr } = child;
        if (stdin === null || stdout === null || stderr === null) {
            child.kill("SIGKILL");
            throw new AcpExecutionError("ACP process streams are unavailable");
        }
        const termination = Promise.withResolvers<AgentTermination>();
        this.termination = termination.promise;
        child.once("error", (cause) => {
            termination.resolve({
                kind: "failed",
                error: new AcpExecutionError("The ACP process could not run", { cause }),
            });
        });
        child.once("exit", (code, signal) => {
            termination.resolve({
                kind: "failed",
                error: new AcpExecutionError("The ACP process stopped", { cause: { code, signal } }),
            });
        });
        let stderrBytes = 0;
        this.#consumeStderr = (chunk) => {
            if (options.maximumOutputBytes !== undefined) {
                stderrBytes += chunk.byteLength;
                if (stderrBytes > options.maximumOutputBytes) {
                    termination.resolve({
                        kind: "failed",
                        error: new AcpExecutionError("ACP adapter error output limit exceeded"),
                    });
                }
                return;
            }
            process.stderr.write(`[${agent.harness}-acp] ${chunk.toString("utf8")}`);
        };
        stderr.on("data", this.#consumeStderr);
        const stream = ndJsonStream(
            createWritableAcpStream(stdin),
            readableAcpStream(stdout, options.maximumOutputBytes),
        );
        let pendingUpdates = 0;
        const client = options.client;
        this.connection = createAcpClient(client)
            .onNotification(methods.client.session.update, async ({ params }) => {
                if (!isIdentifiedNotification(params)) {
                    throw new AcpExecutionError(
                        "The controlled ACP peer emitted an unidentified message",
                        {},
                        "invalid_agent_message_id",
                    );
                }
                // ACP notifications acknowledge writes, not consumption. Pause the child
                // while updates drain so the OS pipe backpressures history replay.
                pendingUpdates += 1;
                stdout.pause();
                try {
                    await client.onUpdate(params);
                } finally {
                    pendingUpdates -= 1;
                    if (pendingUpdates === 0) {
                        stdout.resume();
                    }
                }
            })
            .connect(stream);
    }

    readonly initialize = async (signal: AbortSignal): Promise<void> => signal.throwIfAborted();

    readonly closeProcess = (): Promise<void> => {
        this.#closePromise ??= (async () => {
            try {
                const captured = await captureProcessTree(this.#child);
                this.connection.close();
                this.#child.stdin?.end();
                await stopProcessTree(this.#child, captured);
            } finally {
                this.#child.stderr?.removeListener("data", this.#consumeStderr);
                this.connection.close();
            }
        })();
        return this.#closePromise;
    };

    readonly race = <T>(operation: Promise<T>, exitMessage: string, signal: AbortSignal): Promise<T> =>
        raceAgentOperation(operation, this.termination, exitMessage, signal);
}
