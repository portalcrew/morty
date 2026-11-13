import { base64urlnopad } from "@scure/base";
import { onTestFinished } from "vitest";
import {
    createClientPayloadEncryption,
    createComputerPayloadEncryption,
    exportE2EPublicKey,
    generateE2EIdentity,
} from "../../src/encryption.ts";

export async function openTestPayloadEncryption() {
    const signal = new AbortController().signal;
    const identity = await generateE2EIdentity();
    const access = {
        computerId: "computer-1",
        computerE2EPublicKey: await exportE2EPublicKey(identity.publicKey),
        computerE2EAccessSecret: base64urlnopad.encode(new Uint8Array(32).fill(7)),
    };
    const claimed = new Set<string>();
    const client = await createClientPayloadEncryption(access, signal);
    const computer = await createComputerPayloadEncryption(
        access,
        async (claim) => {
            if (claimed.has(claim.fingerprint)) {
                throw new Error("Duplicate claim");
            }
            claimed.add(claim.fingerprint);
        },
        signal,
    );
    onTestFinished(() => {
        client.close();
        computer.close();
    });
    return { client, computer, signal };
}
