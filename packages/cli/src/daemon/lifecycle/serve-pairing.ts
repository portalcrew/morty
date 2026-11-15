import type { RuntimeInstallationStore } from "../../engine/runtime/connection/runtime-installation-store.ts";
import { type MortyComputerPairingOptions, pairComputerConnection } from "../../engine/runtime/pairing.ts";
import { reloadDaemon } from "./daemon.ts";
import { ensureDaemon, type RunningDaemon } from "./daemon-client.ts";

/** The relay revoked the selected pairing: serving it would only be revoked again, and only setup pairs anew. */
export class ComputerPairingRevokedError extends Error {
    readonly code = "computer_pairing_revoked";

    constructor() {
        super(
            "Morty disconnected this Computer because its connection key was used somewhere else. Run `morty setup` on this computer to pair it again.",
        );
        this.name = "ComputerPairingRevokedError";
    }
}

/** Has a daemon serve the installation's current pairing, starting one when none runs. A revoked pairing is refused. */
export async function serveCurrentPairing(
    installation: RuntimeInstallationStore,
    entry: string,
    environment: Readonly<NodeJS.ProcessEnv>,
    signal: AbortSignal,
): Promise<RunningDaemon> {
    if ((await installation.currentConnection(signal))?.revoked === true) {
        throw new ComputerPairingRevokedError();
    }
    const daemon = await ensureDaemon(installation.stateDirectory, entry, environment, signal);
    await reloadDaemon(installation.stateDirectory, signal);
    return daemon;
}

/** Redeems a pairing the browser offered this computer, saves its connection, and has the daemon serve it. */
export async function pairThisComputer(
    installation: RuntimeInstallationStore,
    pairing: MortyComputerPairingOptions,
    entry: string,
    environment: Readonly<NodeJS.ProcessEnv>,
    signal: AbortSignal,
): Promise<void> {
    await ensureDaemon(installation.stateDirectory, entry, environment, signal);
    await pairComputerConnection(installation, pairing, signal, environment);
    await reloadDaemon(installation.stateDirectory, signal);
}
