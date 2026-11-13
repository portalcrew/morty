import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { SavedComputerConnection } from "../../src/engine/runtime/connection/computer-connection.ts";
import {
    RuntimeInstallationStore,
    type RuntimeInstallationStoreError,
} from "../../src/engine/runtime/connection/runtime-installation-store.ts";

describe("Computer installation storage", () => {
    it("Given an ordinary data directory name, When a host saves a connection, Then local storage accepts the path without treating it as an application identity", async () => {
        const directory = await mkdtemp(join(tmpdir(), "morty-engine-directory-"));
        const signal = new AbortController().signal;
        try {
            const installation = await RuntimeInstallationStore.open(join(directory, "data"), signal);
            const connection = await installation.saveConnection(
                {
                    computerId: "channel_directory",
                    defaultWorkspace: join(directory, "workspace"),
                    relayOrigin: new URL("https://relay.example.com/"),
                    computerCredential: "a".repeat(43),
                },
                signal,
            );
            expect(connection).not.toHaveProperty("applicationId");
            const record: unknown = JSON.parse(await readFile(installation.pairingPath, "utf8"));
            expect(record).not.toHaveProperty("applicationId");
            expect(record).not.toHaveProperty("appId");
            await expect(installation.readConnection(connection.pairingGeneration, signal)).resolves.toEqual(
                connection,
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("Given an existing installation moved to a differently named directory, When a host opens it explicitly, Then old and new entrypoints retain the same identity and connections", async () => {
        const stateRoot = await mkdtemp(join(tmpdir(), "morty-engine-context-"));
        const signal = new AbortController().signal;
        try {
            const original = await RuntimeInstallationStore.open(
                join(stateRoot, "installations", "build.morty.cli"),
                signal,
            );
            const connection = await original.saveConnection(
                {
                    computerId: "channel_context",
                    defaultWorkspace: join(stateRoot, "workspace"),
                    relayOrigin: new URL("https://relay.example.com/"),
                    computerCredential: "a".repeat(43),
                },
                signal,
            );
            const relocated = join(stateRoot, "renamed-data");
            await rename(join(stateRoot, "installations", "build.morty.cli"), relocated);
            const engine = await RuntimeInstallationStore.open(relocated, signal);
            expect(engine.stateDirectory).toBe(relocated);
            await expect(engine.readConnection(connection.pairingGeneration, signal)).resolves.toEqual(connection);
            const saved = await engine.saveConnection(
                {
                    computerId: "channel_new",
                    defaultWorkspace: join(stateRoot, "workspace"),
                    relayOrigin: new URL("https://relay.example.com/"),
                    computerCredential: "b".repeat(43),
                },
                signal,
            );
            await rename(relocated, join(stateRoot, "installations", "build.morty.cli"));
            await expect(original.readConnection(saved.pairingGeneration, signal)).resolves.toEqual(saved);
            await expect(original.readConnection(connection.pairingGeneration, signal)).rejects.toMatchObject({
                code: "connection_not_found",
            });
            await expect(original.currentConnection(signal)).resolves.toEqual(saved);
        } finally {
            await rm(stateRoot, { recursive: true, force: true });
        }
    });

    it("Given two isolated Engine data directories, When each saves a Computer connection, Then each resumes only its own opaque connection", async () => {
        const stateRoot = await mkdtemp(join(tmpdir(), "morty-computer-installations-"));
        const signal = new AbortController().signal;
        const computerId = "shared:channel";
        try {
            const first = await RuntimeInstallationStore.open(join(stateRoot, "first-data"), signal);
            const second = await RuntimeInstallationStore.open(join(stateRoot, "second-data"), signal);
            await first.saveConnection(
                {
                    computerId,
                    defaultWorkspace: "/workspace/first",
                    relayOrigin: new URL("https://relay.example.com/"),
                    computerCredential: "a".repeat(43),
                },
                signal,
            );
            const secondConnection = await second.saveConnection(
                {
                    computerId,
                    defaultWorkspace: "/workspace/second",
                    relayOrigin: new URL("https://relay.example.com/"),
                    computerCredential: "b".repeat(43),
                },
                signal,
            );

            const resumed = await second.readConnection(secondConnection.pairingGeneration, signal);

            expect(resumed.computerId).toBe(computerId);
            expect(resumed).toBeInstanceOf(SavedComputerConnection);
            if (!(resumed instanceof SavedComputerConnection)) {
                throw new Error("Expected a verified Computer connection");
            }
            expect(resumed.computerId).toBe(computerId);
            await expect(second.currentConnection(signal)).resolves.toEqual(resumed);
            expect(first.pairingPath).not.toContain("second-data");
            expect(second.pairingPath).toContain("second-data");
            expect(first.pairingPath).not.toContain(computerId);
            expect(second.pairingPath).not.toContain(computerId);

            await expect(first.readConnection(secondConnection.pairingGeneration, signal)).rejects.toMatchObject({
                code: "connection_not_found",
            } satisfies Pick<RuntimeInstallationStoreError, "code">);
        } finally {
            await rm(stateRoot, { force: true, recursive: true });
        }
    });
});
