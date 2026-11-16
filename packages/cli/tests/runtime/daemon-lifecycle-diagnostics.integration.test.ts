import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeComputerDiagnosticsResult, decodeMessageKind } from "@portalcrew/morty-client/protocol";
import { expect, test } from "vitest";
import { z } from "zod";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import { withControlledDaemonConnection } from "../support/agents/real-daemon.ts";
import { writeControlledAcpExecutable } from "../support/controlled-acp-executable.ts";

// @no-uc: Technical regression; process lifecycle logs must reach Computer bug reports.
test("Given a daemon, When a bug report is read through the Computer, Then it carries the daemon startup and readiness records", async ({
    signal,
}) => {
    const directory = await mkdtemp(join(tmpdir(), "morty-lifecycle-diagnostics-"));
    const executableDirectory = await writeControlledAcpExecutable(directory);
    try {
        await withControlledDaemonConnection(
            signal,
            new ControlledAcpAgentSpecification(),
            {
                MORTY_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent-state"),
                PATH: executableDirectory,
            },
            async (peer) => {
                peer.send(JSON.stringify({ kind: "computer.diagnostics.read", requestId: "lifecycle-report" }));
                for (;;) {
                    const message = await peer.nextMessage();
                    if (decodeMessageKind(message) !== "computer.diagnostics.result") {
                        continue;
                    }
                    const exported = decodeComputerDiagnosticsResult(message);
                    expect(exported.requestId).toBe("lifecycle-report");
                    // Process logs live beside shared control state; diagnostics
                    // must include them alongside this Computer's own daemon.log.
                    const kinds = exported.entries.map((entry) => entry["kind"] ?? "");
                    expect(kinds).toContain("daemon_started");
                    expect(kinds).toContain("daemon_ready");
                    const ready = exported.entries.find((entry) => entry["kind"] === "daemon_ready");
                    expect(ready?.["version"]).toMatch(/^\d+\.\d+\.\d+$/u);
                    expect(exported.entries).toContainEqual(
                        expect.objectContaining({
                            event: "runtime_environment",
                            platform: process.platform,
                            architecture: process.arch,
                            nodeVersion: process.versions.node,
                        }),
                    );
                    // Diagnostics must fit the bounded envelope,
                    // including its strict top-level shape and original bounds.
                    const boundedReport = z
                        .strictObject({
                            kind: z.literal("computer.diagnostics.result"),
                            requestId: z
                                .string()
                                .min(1)
                                .max(128)
                                .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u),
                            truncated: z.boolean(),
                            version: z.string().max(32),
                            entries: z.array(z.record(z.string(), z.string().max(256))).max(200),
                        })
                        .refine((value) => JSON.stringify(value).length <= 65_536)
                        .parse(JSON.parse(message));
                    expect(boundedReport.entries).toEqual(exported.entries);
                    expect(JSON.stringify(exported)).not.toContain(peer.workspace);
                    break;
                }
            },
            "managed",
        );
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
}, 180_000);

test("Given a discovered executable with a known version, When diagnostics are requested through the public Computer protocol, Then the current inventory reports its version without paths or environment values", async ({
    signal,
}) => {
    const directory = await mkdtemp(join(tmpdir(), "morty-inventory-diagnostics-"));
    const executableDirectory = await writeControlledAcpExecutable(directory);
    try {
        await withControlledDaemonConnection(
            signal,
            new ControlledAcpAgentSpecification(),
            {
                MORTY_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent-state"),
                PATH: executableDirectory,
                PRIVATE_DIAGNOSTIC_SECRET: "PRIVATE_ENVIRONMENT_VALUE",
            },
            async (peer) => {
                peer.send(JSON.stringify({ kind: "computer.diagnostics.read", requestId: "inventory-report" }));
                for (;;) {
                    const message = await peer.nextMessage();
                    if (decodeMessageKind(message) !== "computer.diagnostics.result") {
                        continue;
                    }
                    const exported = decodeComputerDiagnosticsResult(message);
                    expect(exported.entries).toContainEqual(
                        expect.objectContaining({
                            event: "agent_inventory",
                            harness: "custom",
                            agentVersion: "1.0.0",
                            executableOverride: "unknown",
                            versionSource: "runtime_catalog",
                        }),
                    );
                    for (const secret of [
                        directory,
                        peer.workspace,
                        "PRIVATE_ENVIRONMENT_VALUE",
                        "PRIVATE_DIAGNOSTIC_SECRET",
                    ]) {
                        expect(message).not.toContain(secret);
                    }
                    break;
                }
            },
        );
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});
