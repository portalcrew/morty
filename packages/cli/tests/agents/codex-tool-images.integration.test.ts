import { createHash } from "node:crypto";
import { appendFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "vitest";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { imageFixture } from "../support/agents/image-fixture.ts";
import { prepareNewRealSession, withRealDaemonConnection } from "../support/agents/real-daemon.ts";
import { verifyImageDelivery } from "../support/agents/verify-image-delivery.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

for (const tool of ["view_image", "mcp"] as const) {
    test(`Given real Codex uses ${tool} on a PNG, When clients watch and reopen the native session, Then the image can be reverse-read without base64 fragments and chatting can continue`, async ({
        signal,
    }) => {
        const prompt =
            tool === "mcp"
                ? "Use the image_test image MCP tool, then reply"
                : "Use the view_image tool to inspect picture.png, then reply";
        await using provider = await FakeOpenAiProvider.start("gpt-4.1", "IMAGE_REPLY", {
            toolPrompt: prompt,
            ...(tool === "mcp" ? { mcpImage: true } : { readPath: "picture.png" }),
        });
        await using agent = await CodexFixture.create(provider);
        await withRealDaemonConnection(signal, new CodexAgentSpecification(), agent.environment, async (peer) => {
            const image = imageFixture(128);
            const path = join(peer.workspace, "picture.png");
            await writeFile(path, image);
            if (tool === "mcp") {
                const home = agent.environment["CODEX_HOME"];
                if (home === undefined) {
                    throw new Error("Codex test home is missing");
                }
                const server = fileURLToPath(new URL("../support/mcp/image-server.ts", import.meta.url));
                await appendFile(
                    join(home, "config.toml"),
                    `\n[mcp_servers.image_test]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([server, path])}\n`,
                );
            }
            const sessionTarget = await prepareNewRealSession(peer, "codex");
            await verifyImageDelivery(
                { ...peer, target: sessionTarget },
                {
                    harness: "codex",
                    image,
                    reference:
                        tool === "mcp"
                            ? `morty-content:image:${createHash("sha256").update(image).digest("hex")}`
                            : pathToFileURL(await realpath(path)).href,
                    prompt,
                },
            );
        });
    });
}
