import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    decodeComputerDiagnosticsResult,
    decodeMessageKind,
    decodeSessionOperationFailedEvent,
    encodeSessionCreateCommand,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import { executableSource } from "../support/agents/executable.ts";
import { withControlledDaemonConnection as withRealDaemon } from "../support/agents/real-daemon.ts";

const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));

test("Given an ACP Agent repeatedly fails Computer initialization, When a conversation is created, Then the public failure has a correlated local diagnostic with the sanitized cause chain", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-prepare-diagnostics-"));
    const executableDirectory = join(directory, "bin");
    const executable = join(executableDirectory, "controlled-acp");
    await mkdir(executableDirectory);
    await writeFile(
        executable,
        executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("1.0.0\\n");
} else {
  process.argv.push(
    "--agent-name", "Controlled ACP",
    "--agent-version", "1.0.0",
    "--no-load-session",
    "--http-mcp",
    "--no-delete-session",
    "--no-fork-session",
    "--no-embedded-context",
  );
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
        { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    try {
        await withRealDaemon(
            new ControlledAcpAgentSpecification(),
            {
                MORTY_FAKE_ACP_ALWAYS_FAIL_RUNTIME_INITIALIZATION: "1",
                MORTY_FAKE_ACP_FAIL_RUNTIME_INITIALIZATION: "Controlled ACP",
                PATH: executableDirectory,
            },
            async (peer) => {
                const requestId = "prepare-with-agent-initialization-failure";
                peer.send(
                    encodeSessionCreateCommand({
                        harness: "controlled-acp",
                        directory: ".",
                        kind: "session.create",
                        requestId,
                        operationId: "initialization-failure",
                        configurations: [],
                    }),
                );
                let failure: ReturnType<typeof decodeSessionOperationFailedEvent>;
                for (;;) {
                    const message = await peer.nextMessage();
                    if (decodeMessageKind(message) === "session.operation.failed") {
                        failure = decodeSessionOperationFailedEvent(message);
                        break;
                    }
                }
                expect(failure).toMatchObject({
                    code: "acp_execution_failed",
                    requestId,
                });
                const diagnostics = await peer.readDiagnostics();
                expect(diagnostics).toContain(`"event":"session_create_failed"`);
                expect(diagnostics).toContain(`"requestId":"${requestId}"`);
                expect(diagnostics).toContain(`"operationId":"initialization-failure"`);
                expect(diagnostics).toContain(`"failureName":"RetryableAcpInitializationError"`);
                expect(diagnostics).toContain(`"cause1Name":"AcpExecutionError"`);
                expect(diagnostics).toContain(`"cause1Message":"Persistent fake ACP initialization failure"`);
                expect(diagnostics).toContain(`"cause2Name":"RequestError"`);
                expect(diagnostics).toContain(`"cause2Message":"Internal error"`);
                expect(diagnostics).toContain(`"cause2Code":"-32603"`);
                peer.send(JSON.stringify({ kind: "computer.diagnostics.read", requestId: "bug-report-diagnostics" }));
                for (;;) {
                    const message = await peer.nextMessage();
                    if (decodeMessageKind(message) !== "computer.diagnostics.result") {
                        continue;
                    }
                    const exported = decodeComputerDiagnosticsResult(message);
                    expect(exported.requestId).toBe("bug-report-diagnostics");
                    expect(exported.entries).toContainEqual(
                        expect.objectContaining({ event: "session_create_failed", requestId, cause2Code: "-32603" }),
                    );
                    expect(JSON.stringify(exported)).not.toContain("Persistent fake ACP initialization failure");
                    expect(JSON.stringify(exported)).not.toContain(peer.workspace);
                    expect(exported.version).toMatch(/^\d+\.\d+\.\d+$/u);
                    break;
                }
            },
        );
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});
