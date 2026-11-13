import { execFile } from "node:child_process";
import { on, once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
    COMPUTER_HEARTBEAT_MESSAGE,
    decodeComputerDiagnosticsResult,
    decodeMessageKind,
    decodeSessionOperationFailedEvent,
    decodeSessionReadyEvent,
} from "@morty-build/client/protocol";
import { listen, port } from "@morty-build/relay-test-support/websocket";
import { expect, test, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { RuntimeInstallationStore } from "../../src/engine/runtime/connection/runtime-installation-store.ts";
import { TestComputerHost } from "../support/computer-host.ts";
import { createEncryptedDaemonFrames } from "../support/encrypted-daemon-frames.ts";

interface ProbeOptions {
    readonly scenario:
        | "delayed"
        | "empty"
        | "nonzero"
        | "nonzero-held"
        | "native-version-once"
        | "readiness-failure"
        | "limit"
        | "held";
    readonly stream: "stdout" | "stderr";
}

interface VersionWriter {
    readonly pid: number;
    readonly closed: Promise<void>;
    readonly release: () => void;
}

async function expectWriterStopped(writer: VersionWriter): Promise<void> {
    await writer.closed;
    if (process.platform !== "linux") {
        expect(() => process.kill(writer.pid, 0)).toThrow();
        return;
    }
    // An orphan's PID may remain until the runner's init reaps it. A zombie
    // cannot execute or retain the output pipe, even though kill(pid, 0) succeeds.
    const stat = await readFile(`/proc/${writer.pid.toString()}/stat`, "utf8").catch((error: unknown) => {
        const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
        // Linux can reap the process between opening its proc entry and reading it.
        if (code === "ENOENT" || code === "ESRCH") {
            return null;
        }
        throw error;
    });
    if (stat !== null) {
        expect(["Z", "X"]).toContain(
            stat
                .slice(stat.lastIndexOf(")") + 1)
                .trimStart()
                .charAt(0),
        );
    }
}

async function createProbeEngine(options: ProbeOptions, signal: AbortSignal) {
    const directory = await mkdtemp(join(tmpdir(), "morty-agent-output-drain-"));
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const pendingWriters: VersionWriter[] = [];
    const writerWaiters: ((writer: VersionWriter) => void)[] = [];
    const writerResponses: ServerResponse[] = [];
    let releaseVersions = options.scenario !== "held" && options.scenario !== "nonzero-held";
    const control = createServer((request, response) => {
        const pid = Number(new URL(request.url ?? "", "http://localhost").searchParams.get("pid"));
        const closed = once(response, "close", { signal }).then(() => undefined);
        void closed.catch(() => undefined);
        const writer = { pid, closed, release: () => response.writeHead(204).end() };
        writerResponses.push(response);
        const waiting = writerWaiters.shift();
        if (waiting === undefined) {
            pendingWriters.push(writer);
        } else {
            waiting(writer);
        }
        if (releaseVersions) {
            writer.release();
        }
    });
    await listen(control);
    const agent = join(directory, "codex.mjs");
    const fixture = new URL("./fixtures/version-probe-peer.mjs", import.meta.url);
    await writeFile(agent, `#!${process.execPath}\nawait import(${JSON.stringify(fixture.href)});\n`, { mode: 0o700 });
    const catalogs: unknown[] = [];
    const http = createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
            body += chunk;
        });
        request.on("end", () => {
            catalogs.push(JSON.parse(body));
            response.writeHead(204).end();
        });
    });
    const relay = new WebSocketServer({ server: http });
    const connected = Promise.withResolvers<WebSocket>();
    const online = Promise.withResolvers<void>();
    void connected.promise.catch(() => undefined);
    void online.promise.catch(() => undefined);
    relay.on("connection", (socket) => {
        connected.resolve(socket);
        socket.send(JSON.stringify({ kind: "computer.liveness.ready" }));
        socket.on("message", (encoded) => {
            if (String(encoded) === '{"kind":"computer.heartbeat"}') {
                socket.send(JSON.stringify({ kind: "computer.heartbeat.ack" }));
            }
        });
    });
    await listen(http);
    const shutdown = new AbortController();
    const loopSignal = AbortSignal.any([signal, shutdown.signal]);
    const engine = new TestComputerHost({
        dataDirectory: join(directory, "computer"),
        agentLaunchEnvironment: {
            PATH: "",
            MORTY_CODEX_PATH: agent,
            MORTY_CLAUDE_PATH: "",
            MORTY_PI_PATH: "",
            MORTY_TEST_PROBE_CONTROL: `http://127.0.0.1:${port(control)}`,
            MORTY_TEST_PROBE_SCENARIO: options.scenario,
            MORTY_TEST_PROBE_STREAM: options.stream,
            MORTY_TEST_PROBE_STATE: join(directory, "probe-state"),
        },
    });
    const saved = await (
        await RuntimeInstallationStore.open(join(directory, "computer"), AbortSignal.timeout(5_000))
    ).saveConnection(
        {
            computerId: "output-drain",
            defaultWorkspace: workspace,
            relayOrigin: new URL(`http://127.0.0.1:${port(http)}`),
            computerCredential: "r".repeat(43),
        },
        signal,
    );
    const encryption = await createEncryptedDaemonFrames(join(directory, "computer"), "output-drain", signal);
    const execution = engine.runLoop({
        pairingGeneration: saved.pairingGeneration,
        signal: loopSignal,
        onConnectionStatus: (status) => {
            if (status === "online") {
                online.resolve();
            }
        },
    });
    void execution.catch((error: unknown) => {
        connected.reject(error);
        online.reject(error);
    });
    return {
        directory,
        catalogs,
        execution,
        shutdown,
        signal: loopSignal,
        allowVersions: () => {
            releaseVersions = true;
            for (const response of writerResponses) {
                if (!response.destroyed && !response.writableEnded) {
                    response.writeHead(204).end();
                }
            }
        },
        localLogs: async () => {
            const { stdout } = await promisify(execFile)(
                process.execPath,
                [resolve(import.meta.dirname, "../../dist/cli.js"), "logs", "--json", "--state-directory", directory],
                { signal, env: { HOME: directory, PATH: "" } },
            );
            return stdout;
        },
        online: async () => ({ socket: (await Promise.all([connected.promise, online.promise]))[0], encryption }),
        nextWriter: async (): Promise<VersionWriter> => {
            const writer = pendingWriters.shift();
            if (writer !== undefined) {
                return writer;
            }
            signal.throwIfAborted();
            return await new Promise<VersionWriter>((resolve, reject) => {
                const received = (value: VersionWriter): void => {
                    signal.removeEventListener("abort", aborted);
                    resolve(value);
                };
                const aborted = (): void => {
                    const index = writerWaiters.indexOf(received);
                    if (index >= 0) {
                        writerWaiters.splice(index, 1);
                    }
                    reject(signal.reason);
                };
                signal.addEventListener("abort", aborted, { once: true });
                writerWaiters.push(received);
            });
        },
        close: async () => {
            shutdown.abort();
            await execution.catch(() => undefined);
            encryption.close();
            for (const socket of relay.clients) {
                socket.terminate();
            }
            await new Promise<void>((resolve) => relay.close(() => http.close(() => resolve())));
            for (const response of writerResponses) {
                response.destroy();
            }
            control.closeAllConnections();
            await new Promise<void>((resolve) => control.close(() => resolve()));
            await rm(directory, { force: true, recursive: true });
        },
    };
}

async function request(
    {
        socket,
        encryption,
    }: { readonly socket: WebSocket; readonly encryption: Awaited<ReturnType<typeof createEncryptedDaemonFrames>> },
    message: Readonly<Record<string, unknown>> & { readonly requestId: string },
    signal: AbortSignal,
) {
    const messages = on(socket, "message", { signal });
    try {
        socket.send(await encryption.encode(JSON.stringify(message)));
        for await (const [encoded] of messages) {
            const raw = String(encoded);
            if (raw === COMPUTER_HEARTBEAT_MESSAGE) continue;
            const decodedFrame = await encryption.decode(raw);
            if (typeof decodedFrame !== "string") {
                throw new Error("Expected a text daemon response");
            }
            const text = decodedFrame;
            const kind = decodeMessageKind(text);
            const decoded =
                kind === "computer.diagnostics.result"
                    ? decodeComputerDiagnosticsResult(text)
                    : kind === "session.ready"
                      ? decodeSessionReadyEvent(text)
                      : kind === "session.operation.failed"
                        ? decodeSessionOperationFailedEvent(text)
                        : null;
            if (decoded !== null && decoded.requestId === message.requestId) {
                return decoded;
            }
        }
        throw new Error("The Runtime disconnected before answering");
    } finally {
        await messages.return?.();
    }
}

async function diagnostics(
    connection: {
        readonly socket: WebSocket;
        readonly encryption: Awaited<ReturnType<typeof createEncryptedDaemonFrames>>;
    },
    signal: AbortSignal,
) {
    const result = await request(connection, { kind: "computer.diagnostics.read", requestId: "probe-report" }, signal);
    if (result.kind !== "computer.diagnostics.result") {
        throw new Error("Expected a Runtime diagnostic report");
    }
    return result;
}

test.for([{ stream: "stdout" }, { stream: "stderr" }] as const)(
    "Given a version launcher exits before its inherited $stream pipe closes, When an Engine discovers the Agent, Then its catalog retains the Agent and a Session can be prepared",
    async (options, { signal }) => {
        vi.useFakeTimers({ now: new Date("2026-10-29T00:00:00Z"), toFake: ["Date"] });
        const peer = await createProbeEngine({ ...options, scenario: "delayed" }, signal);
        try {
            const socket = await peer.online();
            expect(peer.catalogs).toContainEqual(
                expect.objectContaining({
                    agents: expect.arrayContaining([
                        expect.objectContaining({ harness: "codex", agentVersion: "codex-cli 0.154.0" }),
                    ]),
                }),
            );
            expect(
                await request(
                    socket,
                    {
                        kind: "session.create",
                        requestId: "prepare-after-output-drain",
                        operationId: crypto.randomUUID(),
                        configurations: [],
                        harness: "codex",
                        directory: ".",
                    },
                    peer.signal,
                ),
            ).toMatchObject({
                kind: "session.ready",
                requestId: "prepare-after-output-drain",
                target: { harness: "codex", sessionId: expect.any(String) },
                agentVersion: "codex-cli 0.154.0",
            });
        } finally {
            await peer.close();
            vi.useRealTimers();
        }
    },
);

test("Given a native Agent has a valid version and readiness response, When discovery builds its catalog, Then it needs no separate adapter version probe", async ({
    signal,
}) => {
    vi.useFakeTimers({ now: new Date("2026-10-29T00:00:00Z"), toFake: ["Date"] });
    const peer = await createProbeEngine({ scenario: "native-version-once", stream: "stdout" }, signal);
    try {
        await peer.online();
        expect(peer.catalogs).toContainEqual(
            expect.objectContaining({
                agents: expect.arrayContaining([
                    expect.objectContaining({
                        harness: "codex",
                        agentVersion: "codex-cli 0.154.0",
                    }),
                ]),
            }),
        );
    } finally {
        await peer.close();
        vi.useRealTimers();
    }
});

test.for([
    {
        scenario: "empty",
        source: "agent_version",
        code: "agent_probe_failed",
        failureCode: "process_exit_failed",
        exitCode: "0",
        probeReason: "empty_version_output",
    },
    {
        scenario: "nonzero",
        source: "agent_version",
        code: "agent_probe_failed",
        failureCode: "process_exit_failed",
        exitCode: "7",
    },
    {
        scenario: "nonzero-held",
        source: "agent_version",
        code: "agent_probe_failed",
        failureCode: "process_exit_failed",
        exitCode: "7",
    },
    { scenario: "limit", source: "agent_version", code: "agent_probe_failed", failureCode: "process_output_limit" },
    {
        scenario: "readiness-failure",
        source: "acp_readiness",
        code: "acp_incompatible",
        failureCode: "acp_incompatible",
    },
] as const)(
    "Given a $scenario version probe failure, When an Engine publishes its inventory, Then the diagnostic report identifies the failed stage without publishing private output",
    async ({ scenario, code, ...expected }, { signal }) => {
        vi.useFakeTimers({ now: new Date("2026-10-29T00:00:00Z"), toFake: ["Date"] });
        const peer = await createProbeEngine({ scenario, stream: "stdout" }, signal);
        try {
            const socket = await peer.online();
            expect(peer.catalogs).toEqual([{ agents: [] }]);
            const report = await diagnostics(socket, peer.signal);
            expect(report.entries).toContainEqual(
                expect.objectContaining({
                    ...expected,
                    event: "agent_probe_failed",
                    harness: "codex",
                    attempt: "1",
                    timeoutMilliseconds: expected.source === "acp_readiness" ? "60000" : "10000",
                    timestamp: "2026-10-29T00:00:00.000Z",
                    computerId: "output-drain",
                }),
            );
            expect(report.entries).toContainEqual(
                expect.objectContaining({
                    event: "agent_discovery_result",
                    harness: "codex",
                    code,
                }),
            );
            expect(JSON.stringify(report)).not.toContain("private-probe-output-with-credential");
            expect(JSON.stringify(report)).not.toContain(peer.directory);
            expect(await peer.localLogs()).not.toContain("private-probe-output-with-credential");
        } finally {
            await peer.close();
            vi.useRealTimers();
        }
    },
);

test("Given a version launcher exited but a descendant holds its output open, When both deterministic probe deadlines expire, Then discovery reports a bounded timeout and releases both descendants", async ({
    signal,
}) => {
    vi.useFakeTimers({ now: new Date("2026-10-29T00:00:00Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
    const peer = await createProbeEngine({ scenario: "held", stream: "stdout" }, signal);
    try {
        const first = await peer.nextWriter();
        await vi.advanceTimersByTimeAsync(10_000);
        const second = await peer.nextWriter();
        await vi.advanceTimersByTimeAsync(10_000);
        const socket = await peer.online();
        expect(peer.catalogs).toEqual([{ agents: [] }]);
        const report = await diagnostics(socket, peer.signal);
        const failures = report.entries.filter((entry) => entry["event"] === "agent_probe_failed");
        expect(failures).toHaveLength(2);
        expect(failures).toEqual(
            expect.arrayContaining(
                ["1", "2"].map((attempt) =>
                    expect.objectContaining({
                        harness: "codex",
                        source: "agent_version",
                        attempt,
                        failureCode: "process_timeout",
                        exitCode: "0",
                    }),
                ),
            ),
        );
        expect(report.entries).toContainEqual(
            expect.objectContaining({ event: "agent_discovery_result", harness: "codex", code: "agent_probe_timeout" }),
        );
        await expectWriterStopped(first);
        await expectWriterStopped(second);
    } finally {
        await peer.close();
        vi.useRealTimers();
    }
});

test("Given a version pipe times out once, When the retry drains normally, Then discovery retains the Agent and the recovered timeout remains in the diagnostic report", async ({
    signal,
}) => {
    vi.useFakeTimers({ now: new Date("2026-10-29T00:00:00Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
    const peer = await createProbeEngine({ scenario: "held", stream: "stderr" }, signal);
    try {
        const first = await peer.nextWriter();
        await vi.advanceTimersByTimeAsync(10_000);
        await peer.nextWriter();
        peer.allowVersions();
        const socket = await peer.online();
        expect(peer.catalogs).toContainEqual(
            expect.objectContaining({
                agents: expect.arrayContaining([expect.objectContaining({ harness: "codex" })]),
            }),
        );
        const report = await diagnostics(socket, peer.signal);
        expect(report.entries.filter((entry) => entry["event"] === "agent_probe_failed")).toEqual([
            expect.objectContaining({ attempt: "1", failureCode: "process_timeout", source: "agent_version" }),
        ]);
        expect(report.entries).toContainEqual(
            expect.objectContaining({ event: "agent_discovery_result", harness: "codex", code: "ready" }),
        );
        await expectWriterStopped(first);
    } finally {
        await peer.close();
        vi.useRealTimers();
    }
});

test("Given a version pipe remains open after its launcher exits, When the host cancels discovery, Then cancellation is preserved, the descendant exits, and local logs distinguish cancellation from failure", async ({
    signal,
}) => {
    vi.useFakeTimers({ now: new Date("2026-10-29T00:00:00Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
    const peer = await createProbeEngine({ scenario: "held", stream: "stdout" }, signal);
    try {
        const writer = await peer.nextWriter();
        const reason = new Error("Host cancelled discovery");
        peer.shutdown.abort(reason);
        await expect(peer.execution).rejects.toBe(reason);
        expect(peer.catalogs).toEqual([]);
        await expectWriterStopped(writer);
        const logs = await peer.localLogs();
        expect(JSON.parse(logs)).toMatchObject({
            entries: expect.arrayContaining([
                expect.objectContaining({
                    lines: expect.arrayContaining([expect.stringContaining('"event":"agent_probe_cancelled"')]),
                }),
            ]),
        });
        expect(logs).not.toContain("Host cancelled discovery");
    } finally {
        await peer.close();
        vi.useRealTimers();
    }
});
