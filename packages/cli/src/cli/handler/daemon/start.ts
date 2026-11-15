import type { Command } from "commander";
import { ComputerPairingRevokedError, serveCurrentPairing } from "../../../daemon/lifecycle/serve-pairing.ts";
import { openMortyInstallation } from "../../../daemon/pairing/pair-local-computer.ts";
import type { CliContext } from "../../context.ts";

export function registerStartCommand(program: Command, context: CliContext): void {
    program
        .command("start")
        .description("ensure the daemon is running and serving the current pairing")
        .action(async () => {
            const control = await openMortyInstallation(context.shutdownSignal, process.env);
            try {
                const daemon = await serveCurrentPairing(control, context.entry, process.env, context.shutdownSignal);
                process.stdout.write(
                    daemon.started ? `Morty daemon ${daemon.version} started.\n` : "Morty daemon is running.\n",
                );
            } catch (error) {
                if (!(error instanceof ComputerPairingRevokedError)) {
                    throw error;
                }
                process.stderr.write(`${error.message}\n`);
                process.exitCode = 1;
            }
        });
}
