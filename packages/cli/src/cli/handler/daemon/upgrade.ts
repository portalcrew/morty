import type { Command } from "commander";
import { restartDaemon, spawnDetachedCommand } from "../../../daemon/lifecycle/daemon-client.ts";
import { openMortyInstallation } from "../../../daemon/pairing/pair-local-computer.ts";
import type { CliContext } from "../../context.ts";

export const UPDATE_RESTART_DELAY_SECONDS = 15;

export function registerUpgradeCommand(program: Command, context: CliContext): void {
    program
        .command("restart")
        .description("restart the daemon using this Morty CLI release")
        .action(async () => {
            const control = await openMortyInstallation(context.shutdownSignal, process.env);
            const daemon = await restartDaemon(
                control.stateDirectory,
                context.entry,
                process.env,
                context.shutdownSignal,
            );
            process.stdout.write(`Morty daemon ${daemon.version} restarted.\n`);
        });
    program
        .command("update")
        .description(
            `restart the daemon using this Morty CLI release in ${UPDATE_RESTART_DELAY_SECONDS} seconds, so an Agent running it through Morty can reply first`,
        )
        .action(async () => {
            await openMortyInstallation(context.shutdownSignal, process.env);
            // Restarting Morty ends its Agents' processes, so the restart runs on its own and after their reply.
            await spawnDetachedCommand(context.entry, "__restart-later", process.env);
            process.stdout.write(`Morty restarts in ${UPDATE_RESTART_DELAY_SECONDS} seconds.\n`);
        });
}
