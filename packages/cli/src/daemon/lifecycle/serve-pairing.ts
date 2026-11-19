import type { RuntimeInstallationStore } from "../../engine/runtime/connection/runtime-installation-store.ts";
import { type MortyComputerPairingOptions, pairComputerConnection } from "../../engine/runtime/pairing.ts";
import { reloadDaemon } from "./daemon.ts";
import { ensureDaemon, type RunningDaemon } from "./daemon-client.ts";

/** The relay revoked the selected pairing: serving it would only be revoked again, and only setup pairs anew. */
export class ComputerPairingRevokedError extends Error {
    readonly code = "computer_pairing_revoked";

    constructor() {
        super(
            "Morty disconnected this Computer because its pairing is no longer valid. Run `morty setup` on this computer to pair it again.",
        );
        this.name = "ComputerPairingRevokedError";
    }
}

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
