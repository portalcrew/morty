import { E2EError } from "@morty-build/client";
import { readLocalAgentInventory } from "../daemon/agents/local-agent-inventory.ts";
import { pairThisComputer, serveCurrentPairing } from "../daemon/lifecycle/serve-pairing.ts";
import { openMortyInstallation } from "../daemon/pairing/pair-local-computer.ts";
import { UnsupportedAgentVersion } from "../engine/agent/discovery/agent-discovery.ts";
import { ComputerEncryptionStore } from "../engine/runtime/connection/computer-encryption-store.ts";
import type { SetupRuntime } from "./setup.ts";

/**
 * The Morty installation of this computer, driven in setup's own process. Only the daemon runs on its own: it starts
 * from `entry`, the invoking CLI release, never another release resolved through npm.
 */
export function localSetupRuntime(entry: string): SetupRuntime {
    const environment = (directory: string): Readonly<NodeJS.ProcessEnv> => ({
        ...process.env,
        MORTY_STATE_DIRECTORY: directory,
    });
    return {
        encryptionAccess: async (directory, computerId, signal) => {
            const installation = await openMortyInstallation(signal, environment(directory));
            if ((await installation.currentConnection(signal))?.computerId !== computerId) {
                throw new E2EError("e2e_invalid_access");
            }
            const encryption = await ComputerEncryptionStore.open(installation.stateDirectory, computerId, signal);
            return await encryption.access(signal);
        },
        computer: async (directory, signal) => {
            const installation = await openMortyInstallation(signal, environment(directory));
            return (await installation.currentConnection(signal))?.computerId ?? null;
        },
        pair: async (directory, pairing, signal) => {
            const installation = await openMortyInstallation(signal, environment(directory));
            await pairThisComputer(
                installation,
                {
                    relayOrigin: pairing.relayOrigin,
                    computerId: pairing.computerId,
                    pairingCode: pairing.pairingCode,
                    defaultWorkspace: pairing.workspace,
                },
                entry,
                environment(directory),
                signal,
            );
        },
        start: async (directory, signal) => {
            const installation = await openMortyInstallation(signal, environment(directory));
            await serveCurrentPairing(installation, entry, environment(directory), signal);
        },
        agents: async (directory, signal) => {
            const inventory = await readLocalAgentInventory(environment(directory), signal);
            return [
                ...inventory.available.map((discovery) => ({
                    harness: discovery.specification.harness,
                    label: discovery.specification.label,
                    status: "ready",
                    recoveryCommand: "",
                    minimumSupportedVersion: "",
                })),
                ...inventory.unavailable.map((discovery) => ({
                    harness: discovery.specification.harness,
                    label: discovery.specification.label,
                    status: discovery.status,
                    recoveryCommand:
                        discovery.code === "authentication_required"
                            ? discovery.specification.authenticationCommand()
                            : "",
                    minimumSupportedVersion:
                        discovery instanceof UnsupportedAgentVersion ? discovery.minimumSupportedVersion : "",
                })),
            ];
        },
    };
}
