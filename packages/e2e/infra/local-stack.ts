import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { E2EHarness } from "./harness.ts";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureDirectory = fileURLToPath(new URL("../fixtures", import.meta.url));
const chatConfiguration = join(fixtureDirectory, "wrangler.chat.jsonc");
const wranglerExecutable = join(repository, "node_modules", ".bin", "wrangler");

// Choose the Worker port below the ephemeral range (Linux from 32768, macOS and Windows from 49152), so an
// outbound connection or inspector cannot take it between allocation and startup.
const STACK_PORTS = { first: 20_000, last: 32_767 } as const;

async function bindable(port: number): Promise<boolean> {
    const server = createServer();
    const listening = await new Promise<boolean>((resolveListen, reject) => {
        server.once("error", (error: NodeJS.ErrnoException) =>
            error.code === "EADDRINUSE" ? resolveListen(false) : reject(error),
        );
        server.listen(port, "127.0.0.1", () => resolveListen(true));
    });
    if (listening) {
        await new Promise<void>((resolveClose, reject) =>
            server.close((error) => (error ? reject(error) : resolveClose())),
        );
    }
    return listening;
}

async function freePort(taken: ReadonlySet<number> = new Set()) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const port = STACK_PORTS.first + Math.floor(Math.random() * (STACK_PORTS.last - STACK_PORTS.first + 1));
        if (!taken.has(port) && (await bindable(port))) {
            return port;
        }
    }
    throw new Error("Could not allocate a local stack port");
}

// The local relay's Session signing secret; production supplies its own as a deployment secret.
const sessionSigningSecret = "local-development-only-session-signing-secret";

export class LocalStack {
    readonly harness: E2EHarness;
    readonly directories: Readonly<Record<"chat" | "workspace", string>>;
    readonly chatOrigin: string;
    readonly chatPort: number;

    static async create(harness: E2EHarness) {
        const chatPort = await freePort();
        const directories = {
            chat: join(harness.workDirectory, "chat"),
            workspace: join(harness.workDirectory, "workspace"),
        };
        await Promise.all(Object.values(directories).map((path) => mkdir(path, { recursive: true })));
        return new LocalStack(harness, directories, chatPort);
    }

    constructor(harness: E2EHarness, directories: Readonly<Record<"chat" | "workspace", string>>, chatPort: number) {
        this.harness = harness;
        this.directories = directories;
        this.chatOrigin = `http://127.0.0.1:${chatPort}`;
        this.chatPort = chatPort;
    }

    async start() {
        const variables = {
            APP_ORIGIN: this.chatOrigin,
            MORTY_SESSION_SIGNING_SECRET: sessionSigningSecret,
        };
        await this.harness.stage("start-chat", async () => {
            const variableArguments = Object.entries(variables).flatMap(([key, value]) => ["--var", `${key}:${value}`]);
            await this.harness.startWorker("morty", wranglerExecutable, [
                "dev",
                "--config",
                chatConfiguration,
                "--ip",
                "127.0.0.1",
                "--port",
                String(this.chatPort),
                "--inspector-port",
                "0",
                "--persist-to",
                this.directories.chat,
                ...variableArguments,
            ]);
            await this.harness.checkHttp(this.chatOrigin, "morty", (response) => response.status === 200);
        });
        return { sessionSigningSecret };
    }
}
