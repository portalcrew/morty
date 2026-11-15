import { randomUUID } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeSessionReadyEvent, encodeSessionPrepareCommand } from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/engine/agent/specification/vendors/claude-code-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";

test.for([
    { source: "user", trusted: true, alias: false },
    { source: "user directory alias", trusted: true, alias: true },
    { source: "project", trusted: false, alias: false },
])(
    "Given bypass is configured through $source settings, When Claude starts through the daemon, Then only the trusted user mode is inherited",
    async ({ trusted, alias }, { signal }) => {
        await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "PERMISSION_SETTINGS_OK");
        await using agent = await ClaudeFixture.create(provider);
        const home = agent.environment["HOME"];
        if (home === undefined) {
            throw new Error("Missing fixture home");
        }
        const workspace = trusted ? home : join(home, "project");
        const config = join(home, ".claude");
        await mkdir(config, { recursive: true });
        await mkdir(join(workspace, ".claude"), { recursive: true });
        await writeFile(
            join(trusted ? config : join(workspace, ".claude"), "settings.json"),
            JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }),
        );
        let configDirectory = config;
        if (alias) {
            configDirectory = join(home, "config-alias");
            await symlink(config, configDirectory, process.platform === "win32" ? "junction" : "dir");
        }
        const environment = { ...agent.environment, CLAUDE_CONFIG_DIR: configDirectory };
        await withRealDaemon(
            signal,
            new ClaudeCodeAgentSpecification(),
            environment,
            async (peer) => {
                const requestId = randomUUID();
                peer.send(
                    encodeSessionPrepareCommand({
                        kind: "session.prepare",
                        requestId,
                        target: peer.target,
                    }),
                );
                for (;;) {
                    const message = JSON.parse(await peer.nextMessage());
                    if (message.kind === "session.operation.failed") {
                        throw new Error(JSON.stringify(message));
                    }
                    if (message.kind !== "session.ready") {
                        continue;
                    }
                    const ready = decodeSessionReadyEvent(JSON.stringify(message));
                    if (ready.requestId !== requestId) {
                        continue;
                    }
                    const option = ready.configOptions.find((option) => option.id === "mode");
                    expect(option?.type === "select" ? option.currentValue : undefined).toBe(
                        trusted ? "bypassPermissions" : "default",
                    );
                    break;
                }
            },
            "managed",
            workspace,
        );
    },
);
