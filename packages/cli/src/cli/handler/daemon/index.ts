import type { Command } from "commander";
import { runDaemon } from "../../../daemon/lifecycle/daemon.ts";
import { runUpdater } from "../../../daemon/lifecycle/updater.ts";
import type { CliContext } from "../../context.ts";
import { registerQuitCommand } from "./quit.ts";
import { registerReleaseCommand } from "./release.ts";
import { registerStartCommand } from "./start.ts";
import { registerUpgradeCommand } from "./upgrade.ts";

export function registerInternalRuntimeHandlers(program: Command, context: CliContext): void {
    program.command("__daemon", { hidden: true }).action(async () => {
        await runDaemon(context.version, context.entry, context.shutdownSignal);
    });
    program
        .command("__update", { hidden: true })
        .argument("<version>")
        .action(async (version: string) => {
            await runUpdater(version, context.entry, context.shutdownSignal);
        });
}

export function registerDaemonProcessLifecycleHandlers(program: Command, context: CliContext): void {
    registerStartCommand(program, context);
    registerQuitCommand(program, context);
    registerReleaseCommand(program, context);
    registerUpgradeCommand(program, context);
}
