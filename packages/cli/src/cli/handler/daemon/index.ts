import { setTimeout as delay } from "node:timers/promises";
import type { Command } from "commander";
import { runDaemon } from "../../../daemon/lifecycle/daemon.ts";
import { restartDaemon } from "../../../daemon/lifecycle/daemon-client.ts";
import { openMortyInstallation } from "../../../daemon/pairing/pair-local-computer.ts";
import type { CliContext } from "../../context.ts";
import { registerQuitCommand } from "./quit.ts";
import { registerReleaseCommand } from "./release.ts";
import { registerStartCommand } from "./start.ts";
import { registerUpgradeCommand, UPDATE_RESTART_DELAY_SECONDS } from "./upgrade.ts";

export function registerInternalRuntimeHandlers(program: Command, context: CliContext): void {
    program.command("__daemon", { hidden: true }).action(async () => {
        await runDaemon(context.version, context.shutdownSignal);
    });
    program.command("__restart-later", { hidden: true }).action(async () => {
        await delay(UPDATE_RESTART_DELAY_SECONDS * 1000, undefined, { signal: context.shutdownSignal });
        const control = await openMortyInstallation(context.shutdownSignal, process.env);
        await restartDaemon(control.stateDirectory, context.entry, process.env, context.shutdownSignal);
    });
}

export function registerDaemonProcessLifecycleHandlers(program: Command, context: CliContext): void {
    registerStartCommand(program, context);
    registerQuitCommand(program, context);
    registerReleaseCommand(program, context);
    registerUpgradeCommand(program, context);
}
