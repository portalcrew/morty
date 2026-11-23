import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { CodexAcpAgent } from "../../src/engine/acp/harness/codex/agent.ts";
import { CodexAppServerClient } from "../../src/engine/acp/harness/codex/app-server-client.ts";
import { connectSharedCodex } from "../../src/engine/acp/harness/codex/shared-server.ts";
import { spawnProcess, stopProcessTree } from "../../src/engine/util/process/executable.ts";
import { waitForFile } from "../support/acp-process.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test.for(["foreground", "background"] as const)(
    "A phone attaching during a %s Codex command stops further writes by that turn",
    async (phase, { signal }) => {
        type GatedCommand = { socket: Socket; result: Promise<"closed" | "written"> };
        let connected = Promise.withResolvers<GatedCommand>();
        const gate = createServer((socket) => {
            const effect = Promise.withResolvers<"closed" | "written">();
            connected.resolve({ socket, result: effect.promise });
            socket.on("data", () => effect.resolve("written"));
            socket.on("error", (error: NodeJS.ErrnoException) => {
                if (error.code !== "ECONNRESET") {
                    effect.reject(error);
                }
            });
            socket.on("close", () => effect.resolve("closed"));
        });
        await new Promise<void>((resolve) => gate.listen(0, "127.0.0.1", resolve));
        const address = gate.address();
        if (address === null || typeof address === "string") {
            throw new Error("Command gate did not listen");
        }
        const command = `node -e "const s=require('node:net').connect(${address.port},'127.0.0.1');s.once('data',()=>s.end('written'))"`;
        const args = { cmd: command, yield_time_ms: phase === "foreground" ? 10000 : 50 };
        const tool = { name: "exec", input: `text(await tools.exec_command(${JSON.stringify(args)}));` };
        const modelWaiting = Promise.withResolvers<void>();
        const hold = Promise.withResolvers<void>();
        await using provider = await FakeOpenAiProvider.start("morty-test-model", "DONE", {
            toolPrompt: "Run the gated command",
            toolSequence: [tool],
            beforeFirstText: async (_signal, conversation) => {
                if (conversation.includes("Run the gated command for the target")) {
                    modelWaiting.resolve();
                    await hold.promise;
                }
            },
        });
        await using fixture = await CodexFixture.create(provider, { configuredModel: "morty-test-model" });
        const cwd = await mkdtemp(join(tmpdir(), "morty-shared-stop-"));
        const controlDirectory = join(fixture.environment["CODEX_HOME"] ?? "", "app-server-control");
        await mkdir(controlDirectory, { recursive: true, mode: 0o700 });
        const daemon = spawnProcess(fixture.executable, ["app-server", "--listen", "unix://"], {
            cwd,
            env: fixture.environment,
            stdio: "ignore",
        });
        let desktop: CodexAppServerClient | undefined;
        let phone: CodexAcpAgent | undefined;
        let targetCommand: GatedCommand | undefined;
        let neighboringCommand: GatedCommand | undefined;
        try {
            const connect = async () => {
                const socket = await connectSharedCodex(fixture.environment, signal);
                if (!socket) {
                    throw new Error("The shared Codex daemon is not listening");
                }
                return socket;
            };
            const seeded = Promise.withResolvers<void>();
            await waitForFile(controlDirectory, "app-server-control.sock", signal);
            desktop = new CodexAppServerClient({
                socket: await connect(),
                cwd,
                command: fixture.executable,
                environment: fixture.environment,
                handlers: {
                    onNotification: async (method) => {
                        if (method === "turn/completed") {
                            seeded.resolve();
                        }
                    },
                    onServerRequest: async () => {},
                },
            });
            await desktop.initialize(signal);
            const owner = desktop;
            const startThread = async () => {
                const result = z
                    .object({ thread: z.object({ id: z.string() }) })
                    .parse(await owner.request("thread/start", { cwd }, signal));
                return result.thread.id;
            };
            const threadId = await startThread();
            const desktopTurn = (threadId: string, text: string) =>
                owner.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] }, signal);
            await desktopTurn(threadId, "Seed desktop history");
            await seeded.promise;
            const tools = provider.diagnostics().at(-1)?.tools ?? [];
            if (!tools.some((t) => t.name === "exec")) {
                const shell = tools.find((t) => t.name.endsWith("exec_command"));
                if (!shell) {
                    throw new Error("Missing Codex shell tool");
                }
                tool.name = shell.name;
                tool.input = JSON.stringify(args);
            }
            const neighborId = await startThread();
            await desktopTurn(neighborId, "Run the gated command for the other thread");
            neighboringCommand = await connected.promise;
            connected = Promise.withResolvers<GatedCommand>();
            await desktopTurn(threadId, "Run the gated command for the target");
            targetCommand = await connected.promise;
            if (phase === "background") {
                await modelWaiting.promise;
            }
            const reject = async (): Promise<never> => {
                throw new Error("Unexpected interaction");
            };
            phone = new CodexAcpAgent({
                socket: await connect(),
                cwd,
                command: fixture.executable,
                environment: fixture.environment,
                interactions: { onPermission: reject, onElicitation: reject },
                onSessionUpdate: async () => {},
            });
            await phone.initialize(signal);
            await phone.resumeSession({ sessionId: threadId, cwd }, signal);
            await phone.cancel({ sessionId: threadId });
            if (!targetCommand.socket.destroyed) {
                targetCommand.socket.write("commit");
            }
            expect(await targetCommand.result).toBe("closed");
            neighboringCommand.socket.write("commit");
            expect(await neighboringCommand.result).toBe("written");
        } finally {
            hold.resolve();
            targetCommand?.socket.destroy();
            neighboringCommand?.socket.destroy();
            gate.close();
            await phone?.dispose("force");
            desktop?.detach();
            await stopProcessTree(daemon);
            await rm(cwd, { recursive: true, force: true });
        }
    },
);
