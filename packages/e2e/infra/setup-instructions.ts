import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runSetup, type SetupHost, type SetupRuntime } from "../../cli/src/setup/setup.ts";
import { terminalQrCode } from "../../cli/src/setup/terminal-qr.ts";
import { object, text } from "./chat-api.ts";

export async function followSetupInstructions(options: {
    readonly clock?: SetupHost["clock"];
    readonly cwd: string;
    readonly state: string;
    readonly harness: string;
    readonly instructionUrl: string;
    readonly runtime: SetupRuntime;
    readonly replaceComputer?: string;
    readonly agentEnvironment: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
}) {
    const url = new URL(options.instructionUrl);
    const document = await fetch(url, { signal: options.signal, redirect: "error" });
    assert.equal(document.status, 200);
    const markdown = await document.text();
    assert.ok(markdown.includes(`Chat origin: ${url.origin}`));
    const command = markdown.match(/^morty (setup .+)$/mu)?.[1];
    assert.ok(command);
    const args = command.split(/\s+/u).map((argument) =>
        argument
            .replaceAll('"', "")
            .replaceAll("<absolute-current-working-directory>", options.cwd)
            .replaceAll("<own-harness-id>", options.harness)
            .replaceAll("<one-use-ticket>", url.searchParams.get("token") ?? ""),
    );
    const events: Readonly<Record<string, unknown>>[] = [];
    const terminal: string[] = [];
    const exitCode = await runSetup(
        [...args, ...(options.replaceComputer === undefined ? [] : ["--replace-computer", options.replaceComputer])],
        {
            ...(options.clock === undefined ? {} : { clock: options.clock }),
            state: options.state,
            agentEnvironment: options.agentEnvironment,
            emit: (event) => events.push(event),
            // What an Agent's command tool captures: no terminal width, and the colors it keeps.
            showQrCode: async (link) => {
                const drawn = await terminalQrCode(link, { columns: undefined, color: true });
                if (drawn !== null) {
                    terminal.push(drawn);
                }
            },
            runtime: options.runtime,
            signal: options.signal,
        },
    );
    assert.equal(exitCode, 0, JSON.stringify(events));
    const ready = events.find((event) => event["status"] === "ready");
    assert.ok(ready);
    const configuration = object(
        object(JSON.parse(await readFile(join(options.state, "config.json"), "utf8")), "local configuration")[
            "identity"
        ],
        "saved identity",
    );
    return {
        configuration,
        events,
        ready,
        terminal: terminal.join(""),
        identity: {
            computerId: text(configuration["computer_id"], "saved computer"),
        },
    };
}
