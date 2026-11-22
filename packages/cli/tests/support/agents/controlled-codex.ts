import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class ControlledCodexFixture implements AsyncDisposable {
    readonly environment: Readonly<Record<string, string>>;
    readonly #directory: string;

    private constructor(directory: string, executable: string) {
        this.#directory = directory;
        const missing = join(directory, "missing-agent");
        this.environment = Object.freeze({
            MORTY_CLAUDE_PATH: missing,
            MORTY_CODEX_PATH: executable,
            MORTY_PI_PATH: missing,
        });
    }

    static async create(
        options: {
            readonly holdTurn?: boolean;
            readonly consumeSteeringAfterFirstTurn?: boolean;
            readonly endFirstTurnOnSteering?: "completed" | "failed" | "interrupted";
            readonly failTurnWith?: string;
            readonly latePreviousUser?: boolean;
            readonly nextPrompt?: string;
            readonly skipSecondSteering?: boolean;
        } = {},
    ): Promise<ControlledCodexFixture> {
        const directory = await mkdtemp(join(tmpdir(), "morty-controlled-codex-"));
        const executable = join(directory, "codex.mjs");
        await writeFile(
            executable,
            `#!${process.execPath}
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
    process.stdout.write("codex-cli 0.154.0\\n");
    process.exit(0);
}
if (process.argv[2] !== "app-server") {
    process.exit(1);
}

let threadNumber = 0;
let turnNumber = 0;
let steeringNumber = 0;
let active;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    if (request.method === "thread/start") {
        send({ id: request.id, result: { thread: { id: "controlled-thread-" + ++threadNumber } } });
        return;
    }
    if (request.method === "turn/start") {
        const threadId = request.params.threadId;
        const turn = { id: "controlled-turn-" + ++turnNumber, status: "inProgress" };
        active = { threadId, turn };
        send({ id: request.id, result: { turn } });
        send({ method: "turn/started", params: { threadId, turn } });
        if (${options.latePreviousUser === true} && turnNumber > 1) {
            send({ method: "item/started", params: { threadId, turnId: "controlled-turn-1",
                item: { type: "userMessage", id: "late-cancelled-user", content: [{ type: "text", text: "Late old input" }] },
            } });
        }
        send({ method: "item/started", params: { threadId, turnId: turn.id,
            item: { type: "userMessage", id: "controlled-user-" + turnNumber, clientId: request.params.clientUserMessageId, content: request.params.input },
        } });
        send({ method: "thread/settings/updated", params: {
            threadId, threadSettings: { collaborationMode: { mode: "plan" } },
        } });
        if (${JSON.stringify(options.failTurnWith ?? null)} !== null) {
            send({ method: "turn/completed", params: { threadId, turn: { ...turn, status: "failed", error: { message: ${JSON.stringify(options.failTurnWith ?? null)} } } } });
        } else if (!${options.holdTurn === true}) {
            send({ method: "turn/completed", params: { threadId, turn: { ...turn, status: "completed" } } });
        }
        return;
    }
    if (request.method === "turn/steer") {
        steeringNumber++;
        send({ id: request.id, result: { turnId: active.turn.id } });
        if (${options.skipSecondSteering === true} && steeringNumber === 2) return;
        if (${JSON.stringify(options.endFirstTurnOnSteering ?? null)} !== null && turnNumber === 1) {
            send({ method: "turn/completed", params: { threadId: active.threadId, turn: { ...active.turn, status: ${JSON.stringify(options.endFirstTurnOnSteering ?? "completed")} } } });
        }
        if (${options.consumeSteeringAfterFirstTurn === true} && turnNumber > 1) {
            send({ method: "item/started", params: { threadId: active.threadId, turnId: active.turn.id,
                item: { type: "userMessage", id: "controlled-steering-user-" + turnNumber, clientId: request.params.clientUserMessageId, content: request.params.input },
            } });
        }
        return;
    }
    if (request.method === "thread/sample" && ${JSON.stringify(options.nextPrompt ?? null)} !== null) {
        if (request.params.expectedTurnId !== active?.turn.id) {
            send({ id: request.id, error: { code: -32600, message: "The source turn is not the latest" } });
            return;
        }
        send({ id: request.id, result: { sourceTurnId: active.turn.id, responseId: "controlled-sample",
            text: JSON.stringify({ suggestion: ${JSON.stringify(options.nextPrompt ?? null)} }) } });
        return;
    }
    if (request.method === "turn/interrupt") {
        send({ id: request.id, result: {} });
        send({ method: "turn/completed", params: { threadId: active.threadId, turn: { ...active.turn, status: "interrupted" } } });
        return;
    }
    const result = request.method === "model/list" ? { data: [], nextCursor: null } : {};
    process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
});
`,
            { mode: 0o700 },
        );
        return new ControlledCodexFixture(directory, executable);
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await rm(this.#directory, { force: true, recursive: true });
    }
}
