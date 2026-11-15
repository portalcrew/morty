import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { RuntimeInstallationStore } from "../../src/engine/runtime/connection/runtime-installation-store.ts";

test("Given a rotated connection, When replacement pairing is cancelled, Then the current credential remains usable", async () => {
    const root = await mkdtemp(join(tmpdir(), "morty-credential-cancel-"));
    const signal = new AbortController().signal;
    try {
        const installation = await RuntimeInstallationStore.open(root, signal);
        const input = {
            computerId: "computer_scan",
            defaultWorkspace: root,
            relayOrigin: new URL("https://relay.example.com/"),
            computerCredential: "a".repeat(43),
        };
        const connection = await installation.saveConnection(input, signal);
        const credentials = installation.computerCredentials(connection.pairingGeneration);
        const rotation = await credentials.prepare(signal);
        await credentials.complete(rotation, signal);
        expect((await credentials.held(signal)).current === rotation.successor).toBe(true);
        await expect(installation.saveConnection(input, AbortSignal.abort())).rejects.toMatchObject({
            name: "AbortError",
        });
        expect((await installation.currentConnection(signal))?.pairingGeneration).toBe(connection.pairingGeneration);
        expect((await credentials.held(signal)).current === rotation.successor).toBe(true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("Given a running credential rotation, When the pairing is replaced concurrently, Then the new pairing can read its credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "morty-credential-replace-"));
    const signal = new AbortController().signal;
    try {
        const installation = await RuntimeInstallationStore.open(root, signal);
        const input = {
            computerId: "computer_scan",
            defaultWorkspace: root,
            relayOrigin: new URL("https://relay.example.com/"),
            computerCredential: "a".repeat(43),
        };
        const old = await installation.saveConnection(input, signal);
        const credentials = installation.computerCredentials(old.pairingGeneration);
        const rotated = await credentials.prepare(signal);
        await credentials.complete(rotated, signal);
        const replacementHost = await RuntimeInstallationStore.open(root, signal);
        const replacementInput = { ...input, computerCredential: "b".repeat(43) };
        const [rotation, pairing] = await Promise.allSettled([
            credentials.prepare(signal),
            replacementHost.saveConnection(replacementInput, signal),
        ]);
        // Contending changes can ask the caller to retry without committing a partial replacement.
        if (pairing.status === "rejected") {
            expect(pairing.reason).toMatchObject({ code: "pairing_busy" });
        }
        const replacement =
            pairing.status === "fulfilled"
                ? pairing.value
                : await replacementHost.saveConnection(replacementInput, signal);
        const current = installation.computerCredentials(replacement.pairingGeneration);
        expect(replacement.computerId).toBe(old.computerId);
        expect(replacement.pairingGeneration).not.toBe(old.pairingGeneration);
        await expect(credentials.held(signal)).rejects.toMatchObject({ code: "connection_not_found" });
        await expect(credentials.prepare(signal)).rejects.toMatchObject({ code: "connection_not_found" });
        await expect(installation.recordRevocation(old.pairingGeneration, signal)).rejects.toMatchObject({
            code: "connection_not_found",
        });
        expect(await installation.currentConnection(signal)).toEqual(replacement);
        expect((await current.held(signal)).current === replacementInput.computerCredential).toBe(true);
        if (rotation.status === "fulfilled") {
            await expect(credentials.complete(rotation.value, signal)).rejects.toMatchObject({
                code: "connection_not_found",
            });
        } else {
            expect(rotation.reason).toMatchObject({ code: "pairing_busy" });
        }
        const next = await current.prepare(signal);
        await installation.recordRevocation(replacement.pairingGeneration, signal);
        await current.complete(next, signal);
        const reopened = await RuntimeInstallationStore.open(root, signal);
        expect(
            (await reopened.computerCredentials(replacement.pairingGeneration).held(signal)).current === next.successor,
        ).toBe(true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
