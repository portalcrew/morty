import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClientPayloadEncryption, createComputerPayloadEncryption, E2EError } from "@morty-build/client";
import {
    agentSettingsDiscoverCommandCodec,
    agentSettingsDiscoveryFailedEventCodec,
    computerPingCommandCodec,
    contentWriteCommandCodec,
    fileFailedEventCodec,
    sessionOperationFailedEventCodec,
} from "@morty-build/client/protocol";
import { WebSocket } from "undici";
import { expect, it, vi } from "vitest";
import { WebSocket as PeerWebSocket, WebSocketServer } from "ws";
import { reportAuthenticatedCapacity } from "../../src/engine/runtime/command/registry/capacity.ts";
import { receive } from "../../src/engine/runtime/command/transport.ts";
import { ComputerEncryptionStore } from "../../src/engine/runtime/connection/computer-encryption-store.ts";

it("Given a Computer receiving sustained authenticated traffic, when more than 2,048 commands arrive within one replay window, then every fresh command opens and a replay remains rejected after reopening", {
    timeout: 120_000,
}, async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-12T00:00:00Z") });
    const directory = await mkdtemp(join(tmpdir(), "morty-encryption-throughput-"));
    const signal = new AbortController().signal;
    try {
        const store = await ComputerEncryptionStore.open(directory, "computer-1", signal);
        const access = await store.access(signal);
        const client = await createClientPayloadEncryption(access, signal);
        const computer = await createComputerPayloadEncryption(
            access,
            (claim, claimSignal) => store.authorizeAndClaim(access.computerE2EAccessSecret, claim, claimSignal),
            signal,
        );
        let first: string | null = null;
        try {
            for (let index = 0; index < 2_050; index += 1) {
                const command = { kind: "computer.ping", requestId: `request-${index}` };
                const encoded = await computerPingCommandCodec.encode(command, client, signal);
                if (first === null) {
                    first = encoded;
                }
                expect(await computerPingCommandCodec.decode(encoded, computer, signal)).toEqual(command);
            }
        } finally {
            computer.close();
            client.close();
        }
        if (first === null) {
            throw new Error("Expected an authenticated command");
        }
        const reopened = await ComputerEncryptionStore.open(directory, "computer-1", signal);
        const restarted = await createComputerPayloadEncryption(
            access,
            (claim, claimSignal) => reopened.authorizeAndClaim(access.computerE2EAccessSecret, claim, claimSignal),
            signal,
        );
        const freshClient = await createClientPayloadEncryption(access, signal);
        try {
            await expect(computerPingCommandCodec.decode(first, restarted, signal)).rejects.toMatchObject({
                code: "e2e_invalid_frame",
            });
            const fresh = { kind: "computer.ping", requestId: "after-replay" };
            expect(
                await computerPingCommandCodec.decode(
                    await computerPingCommandCodec.encode(fresh, freshClient, signal),
                    restarted,
                    signal,
                ),
            ).toEqual(fresh);
            vi.setSystemTime(new Date("2026-11-12T00:05:00Z"));
            const later = { kind: "computer.ping", requestId: "later-command" };
            expect(
                await computerPingCommandCodec.decode(
                    await computerPingCommandCodec.encode(later, freshClient, signal),
                    restarted,
                    signal,
                ),
            ).toEqual(later);
        } finally {
            freshClient.close();
            restarted.close();
        }
        vi.setSystemTime(new Date("2026-11-12T00:00:00Z"));
        const afterRollback = await createComputerPayloadEncryption(
            access,
            (claim, claimSignal) => reopened.authorizeAndClaim(access.computerE2EAccessSecret, claim, claimSignal),
            signal,
        );
        const rollbackClient = await createClientPayloadEncryption(access, signal);
        try {
            const packet = await computerPingCommandCodec.encode(
                { kind: "computer.ping", requestId: "rollback" },
                rollbackClient,
                signal,
            );
            await expect(computerPingCommandCodec.decode(packet, afterRollback, signal)).rejects.toMatchObject({
                code: "e2e_invalid_frame",
            });
        } finally {
            rollbackClient.close();
            afterRollback.close();
        }
    } finally {
        vi.useRealTimers();
        await rm(directory, { recursive: true, force: true });
    }
});

it("Given an authenticated request when replay admission is busy, then the client receives the correlated encrypted capacity failure", {
    timeout: 30_000,
}, async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-12T00:00:00Z") });
    const directory = await mkdtemp(join(tmpdir(), "morty-encryption-busy-"));
    const server = createServer();
    const peers = new WebSocketServer({ server });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Expected a listening socket");
    }
    const signal = new AbortController().signal;
    const store = await ComputerEncryptionStore.open(directory, "computer-1", signal);
    const access = await store.access(signal);
    const client = await createClientPayloadEncryption(access, signal);
    const claims = new Set<string>();
    const computer = await createComputerPayloadEncryption(
        access,
        async (claim, claimSignal) => {
            claimSignal.throwIfAborted();
            if (claims.has(claim.fingerprint)) {
                throw new E2EError("e2e_invalid_frame");
            }
            if (claims.size >= 1) {
                throw new E2EError("e2e_store_busy");
            }
            claims.add(claim.fingerprint);
        },
        signal,
    );
    const connected = once(peers, "connection");
    const daemon = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const [peer] = await connected;
    if (!(peer instanceof PeerWebSocket)) {
        throw new Error("Expected a WebSocket peer");
    }
    await once(daemon, "open");
    try {
        const first = await computerPingCommandCodec.encode(
            { kind: "computer.ping", requestId: "first" },
            client,
            signal,
        );
        expect(await receive(first, computer, signal)).toMatchObject({ kind: "computer.ping", requestId: "first" });
        const second = await computerPingCommandCodec.encode(
            { kind: "computer.ping", requestId: "busy-request" },
            client,
            signal,
        );
        await expect(receive(second, computer, signal)).rejects.toMatchObject({ code: "e2e_store_busy" });
        const reply = once(peer, "message");
        expect(await reportAuthenticatedCapacity({ socket: daemon, payloadEncryption: computer, signal }, second)).toBe(
            true,
        );
        const [wire] = await reply;
        expect(await sessionOperationFailedEventCodec.decode(String(wire), client, signal)).toMatchObject({
            kind: "session.operation.failed",
            requestId: "busy-request",
            code: "e2e_store_busy",
        });
        const settings = await agentSettingsDiscoverCommandCodec.encode(
            { kind: "agent.settings.discover", requestId: "settings-request", harness: "codex" },
            client,
            signal,
        );
        await expect(receive(settings, computer, signal)).rejects.toMatchObject({ code: "e2e_store_busy" });
        const settingsReply = once(peer, "message");
        expect(
            await reportAuthenticatedCapacity({ socket: daemon, payloadEncryption: computer, signal }, settings),
        ).toBe(true);
        const [settingsWire] = await settingsReply;
        expect(await agentSettingsDiscoveryFailedEventCodec.decode(String(settingsWire), client, signal)).toMatchObject(
            {
                kind: "agent.settings.discovery.failed",
                requestId: "settings-request",
                code: "e2e_store_busy",
            },
        );
        const target = { harness: "codex", sessionId: "session-1" };
        const write = await contentWriteCommandCodec.encode(
            {
                kind: "content.write",
                requestId: "upload-request",
                target,
                contentKey: "a".repeat(64),
                contentKind: "resource",
                byteLength: 1,
                mediaType: "text/plain",
                name: "a.txt",
            },
            client,
            signal,
        );
        await expect(receive(write, computer, signal)).rejects.toMatchObject({ code: "e2e_store_busy" });
        const uploadReply = once(peer, "message");
        expect(await reportAuthenticatedCapacity({ socket: daemon, payloadEncryption: computer, signal }, write)).toBe(
            true,
        );
        const [uploadWire] = await uploadReply;
        expect(await fileFailedEventCodec.decode(String(uploadWire), client, signal)).toMatchObject({
            kind: "file.failed",
            requestId: "upload-request",
            target,
            code: "e2e_store_busy",
        });
    } finally {
        daemon.close();
        peer.terminate();
        computer.close();
        client.close();
        await new Promise<void>((resolve, reject) => peers.close((error) => (error ? reject(error) : resolve())));
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        vi.useRealTimers();
        await rm(directory, { recursive: true, force: true });
    }
});
