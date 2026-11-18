import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import * as v from "valibot";
import { expect, test } from "vitest";
import { mortyReply } from "../../../tests/support/fake-daemon/scenarios.ts";
import { createSetupReporter } from "../../cli/src/setup/output.ts";
import { runSetup } from "../../cli/src/setup/setup.ts";
import { ControlledSetupRuntime } from "../../e2e/infra/setup-daemon.ts";
import { createIdentityFixture } from "./support/identity-fixture.ts";

const requireCli = createRequire(new URL("../../cli/package.json", import.meta.url));
const decode: unknown = requireCli("jsqr");
const pngConstructor = v.parse(v.object({ PNG: v.function() }), requireCli("pngjs")).PNG;
const png = v.parse(v.object({ read: v.function() }), Reflect.get(pngConstructor, "sync"));

function decoded(data: Uint8ClampedArray, width: number, height: number): string {
    if (typeof decode !== "function") {
        throw new Error("Missing QR decoder");
    }
    return v.parse(v.object({ data: v.string() }), decode(data, width, height)).data;
}

function scanTerminal(output: string): string {
    const lines = stripVTControlCharacters(output)
        .split("\n")
        .filter((line) => /^[ █▀▄]+$/u.test(line));
    const width = lines[0]?.length ?? 0;
    expect(width).toBeGreaterThan(8);
    expect(lines.every((line) => line.length === width)).toBe(true);
    expect(lines.slice(0, 2).every((line) => line.trim() === "")).toBe(true);
    expect(lines.every((line) => line.startsWith("    ") && line.endsWith("    "))).toBe(true);
    const scale = 4;
    const height = lines.length * 2;
    const data = new Uint8ClampedArray(width * height * scale * scale * 4).fill(255);
    for (let y = 0; y < height * scale; y++) {
        for (let x = 0; x < width * scale; x++) {
            const glyph = lines[Math.floor(y / (scale * 2))]?.[Math.floor(x / scale)];
            const top = Math.floor(y / scale) % 2 === 0;
            const dark = glyph === "█" || (top ? glyph === "▀" : glyph === "▄");
            const offset = (y * width * scale + x) * 4;
            data[offset] = data[offset + 1] = data[offset + 2] = dark ? 0 : 255;
        }
    }
    return decoded(data, width * scale, height * scale);
}

test("Given setup in terminal and GUI agents, When the user connects their computer, Then a scannable terminal QR or GUI PNG opens the exact same handoff without changing JSON output", {
    timeout: 120_000,
}, async ({ signal }) => {
    await using cleanup = new AsyncDisposableStack();
    const fixture = await createIdentityFixture({ listenOnLoopback: true });
    cleanup.defer(() => fixture.close());
    const root = await realpath(await mkdtemp(join(tmpdir(), "morty-setup-qr-")));
    cleanup.defer(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, "project with spaces");
    await mkdir(workspace);
    for (const scenario of [
        { harness: "codex", qr: "terminal", tty: false, columns: undefined, noColor: true, draws: true },
        { harness: "claude", qr: "terminal", tty: false, columns: 160, noColor: false, draws: true },
        { harness: "pi", qr: "auto", tty: true, columns: 160, noColor: false, draws: true },
        { harness: "pi", qr: "terminal", tty: true, columns: 160, noColor: true, draws: true },
        { harness: "codex", qr: "image", tty: true, columns: 160, noColor: false, draws: false },
        { harness: "claude", qr: "image", tty: true, columns: 160, noColor: false, draws: false },
        { harness: "codex", qr: "auto", tty: false, columns: 160, noColor: false, draws: false },
        { harness: "pi", qr: "terminal", tty: true, columns: 40, noColor: false, draws: false },
    ] as const) {
        await using run = new AsyncDisposableStack();
        const runtime = new ControlledSetupRuntime(
            { harness: scenario.harness, agentName: scenario.harness, reply: mortyReply },
            "QR setup computer",
        );
        run.defer(() => runtime.disconnect());
        const stdout = new PassThrough();
        const stderr = Object.assign(new PassThrough(), {
            isTTY: scenario.tty,
            ...(scenario.columns === undefined ? {} : { columns: scenario.columns }),
        });
        run.defer(() => {
            stdout.destroy();
            stderr.destroy();
        });
        const environment = { codex: "CODEX_THREAD_ID", claude: "CLAUDE_CODE_SESSION_ID", pi: "PI_SESSION_ID" };
        let time = Date.parse("2026-11-18T00:00:00Z");
        const status = await runSetup(
            ["setup", "--base-url", fixture.origin, "--cwd", workspace, "--harness", scenario.harness],
            {
                state: join(root, crypto.randomUUID()),
                runtime,
                signal,
                agentEnvironment: { [environment[scenario.harness]]: `native-${scenario.harness}` },
                emit: createSetupReporter({ stdout, stderr, qr: scenario.qr, noColor: scenario.noColor }),
                clock: {
                    now: () => new Date(time),
                    wait: async (milliseconds, parent) => {
                        parent.throwIfAborted();
                        time += milliseconds;
                    },
                },
            },
        );
        const json = String(stdout.read() ?? "");
        expect(status, json).toBe(0);
        const events = json
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        const ready = v.parse(
            v.object({
                status: v.literal("ready"),
                computerId: v.string(),
                url: v.string(),
                qrPath: v.string(),
                workspace: v.literal(workspace),
            }),
            events.at(-1),
        );
        run.defer(() => rm(ready.qrPath, { force: true }));
        const image = v.parse(
            v.object({ data: v.instance(Buffer), width: v.number(), height: v.number() }),
            png.read(await readFile(ready.qrPath)),
        );
        expect(decoded(new Uint8ClampedArray(image.data), image.width, image.height)).toBe(ready.url);
        const url = new URL(ready.url);
        expect(url.searchParams.get("harness")).toBe(scenario.harness);
        expect(url.searchParams.get("sessionId")).toBe(`native-${scenario.harness}`);
        const output = String(stderr.read() ?? "");
        if (scenario.draws) {
            expect(scanTerminal(output)).toBe(ready.url);
            if (scenario.noColor || !scenario.tty) {
                expect(output).toBe(stripVTControlCharacters(output));
            } else {
                expect(output).toContain("\x1b[30;47m");
            }
        } else if (scenario.columns === 40) {
            expect(output).toContain("too narrow");
            expect(output).not.toMatch(/[█▀▄]/u);
        } else {
            expect(output).toBe("");
        }
        const redeemed = await fetch(new URL("/morty/api/v1/identity/transfers/redeem", fixture.origin), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code: new URLSearchParams(url.hash.slice(1)).get("code") }),
            signal,
        });
        expect(redeemed.status).toBe(200);
        expect(await redeemed.json()).toMatchObject({ computerId: ready.computerId });
    }
});
