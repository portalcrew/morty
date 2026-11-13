import { createClientPayloadEncryption, type PayloadEncryptor } from "@morty-build/client";
import { daemonInboundSignatures, decodeEncryptedDaemonMessage, decodeMessageKind } from "@morty-build/client/protocol";
import { ComputerEncryptionStore } from "../../src/engine/runtime/connection/computer-encryption-store.ts";

/** Exercises the daemon's real message codecs using its persisted Computer capability. */
export async function createEncryptedDaemonFrames(stateDirectory: string, computerId: string, signal: AbortSignal) {
    const store = await ComputerEncryptionStore.open(stateDirectory, computerId, signal);
    const encryption = await createClientPayloadEncryption(await store.access(signal), signal);
    const codecs: Readonly<
        Record<
            string,
            {
                readonly encode: (
                    message: unknown,
                    encryption: PayloadEncryptor,
                    signal: AbortSignal,
                ) => Promise<string>;
            }
        >
    > = daemonInboundSignatures;
    return {
        encryption,
        encode: async (message: string): Promise<string> => {
            const codec = codecs[decodeMessageKind(message)];
            if (codec === undefined) {
                throw new Error("Unsupported daemon test command");
            }
            const value: unknown = JSON.parse(message);
            return await codec.encode(value, encryption, signal);
        },
        decode: async (message: string): Promise<string> => {
            return JSON.stringify(await decodeEncryptedDaemonMessage(message, encryption, signal));
        },
        close: encryption.close,
    };
}
