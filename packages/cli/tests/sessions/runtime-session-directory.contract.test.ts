import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WsTransport } from "@morty-build/client";
import {
    type SessionCreateCommand,
    sessionCreateCommandCodec,
    sessionReadyEventCodec,
} from "@morty-build/client/protocol";
import { expect, it, onTestFinished } from "vitest";
import { startTestRelay } from "../support/relay.ts";

for (const client of ["SDK", "HTTP"] as const) {
    it(`Given a new Session, When ${client} creates and prompts it, Then its conversation uses the Computer title and workspace`, async () => {
        const cancellation = new AbortController();
        await using relay = await startTestRelay();
        try {
            const owner = await relay.createOwner();
            const runtime = await relay.connectAgent(owner.computerId);
            const request = {
                harness: "claude",
                configurations: [],
                directory: ".",
                computerId: runtime.computerId,
                operationId: crypto.randomUUID(),
            };
            const ready =
                client === "SDK"
                    ? await runtime.createSession(request, cancellation.signal)
                    : await (async () => {
                          const transport = new WsTransport();
                          onTestFinished(() => transport.close());
                          transport.configureEncryption(await runtime.encryptionAccess(cancellation.signal));
                          const command = {
                              kind: "session.create",
                              requestId: crypto.randomUUID(),
                              operationId: request.operationId,
                              harness: request.harness,
                              configurations: request.configurations,
                              directory: request.directory,
                          } satisfies SessionCreateCommand;
                          const body = await sessionCreateCommandCodec.encode(
                              command,
                              transport.payloadEncryption,
                              cancellation.signal,
                          );
                          const response = await relay.app.request(
                              new Request(
                                  `${relay.baseUrl}/morty/api/v1/computers/${owner.computerId}/managed-sessions/open`,
                                  {
                                      method: "POST",
                                      headers: {
                                          authorization: `Bearer ${owner.token}`,
                                          "content-type": "application/json",
                                      },
                                      body,
                                      signal: cancellation.signal,
                                  },
                              ),
                          );
                          expect(response.status).toBe(200);
                          const access: unknown = await response.json();
                          if (typeof access !== "object" || access === null || !("ready" in access)) {
                              throw new Error("Missing Session access");
                          }
                          const ready = await sessionReadyEventCodec.decode(
                              JSON.stringify(access.ready),
                              transport.payloadEncryption,
                              cancellation.signal,
                          );
                          expect(ready.requestId).toBe(command.requestId);
                          return ready;
                      })();
            const { target: sessionTarget } = ready;
            expect(ready).toMatchObject({
                kind: "session.ready",
                target: sessionTarget,
                harness: "claude",
                directory: ".",
            });
            await (await runtime.sessionClient(sessionTarget, cancellation.signal)).turns.submit(
                sessionTarget,
                {
                    attachments: [],
                    content: "Remember this conversation",
                    idempotencyKey: `turn-${crypto.randomUUID()}`,
                },
                cancellation.signal,
            );

            await expect(runtime.api.managedSessions(cancellation.signal)).resolves.toEqual([
                expect.objectContaining({
                    directory: expect.any(String),
                    prompted: true,
                    target: sessionTarget,
                    // Admission does not wait for completion; either live state describes this conversation.
                    status: expect.objectContaining({ kind: expect.stringMatching(/^(idle|working)$/u) }),
                    title: "Remember this conversation",
                }),
            ]);
        } finally {
            cancellation.abort(new Error("Computer Session directory test completed"));
        }
    });
}

it("Given long ASCII and multibyte directory references, When the SDK browses them, Then the local filesystem remains the authority for directory availability", async () => {
    await using relay = await startTestRelay();
    const signal = AbortSignal.timeout(30_000);
    const owner = await relay.createOwner();
    const runtime = await relay.connectAgent(owner.computerId);
    for (const segment of ["a".repeat(220), "\u00e9".repeat(110)]) {
        const path = join(
            tmpdir(),
            `missing-${crypto.randomUUID()}`,
            ...Array.from({ length: Math.ceil(2100 / segment.length) }, () => segment),
        );
        const directory = path;
        expect(directory.length).toBeGreaterThan(2048);
        await expect(runtime.api.directory(directory, signal)).rejects.toMatchObject({
            code: "local_authorization_failed",
        });
    }
});

it("Given a deeply nested multibyte project path, When the SDK browses it and runs a conversation, Then directory metadata and native history remain accessible", async () => {
    const root = await mkdtemp(join(tmpdir(), "morty-long-workspace-"));
    try {
        const path = join(
            root,
            ...Array.from({ length: process.platform === "linux" ? 8 : 3 }, () => "\u00e9".repeat(110)),
        );
        await mkdir(path, { recursive: true });
        const canonical = await realpath(path);
        await using relay = await startTestRelay();
        const signal = AbortSignal.timeout(30_000);
        const owner = await relay.createOwner();
        const runtime = await relay.connectAgent(owner.computerId);
        const directory = canonical;
        const listing = await runtime.api.directory(directory, signal);
        expect(listing.directory).toBe(directory);
        expect(listing.directoryLabel).toBe(canonical);
        expect(listing.parentDirectory).toBe(dirname(canonical));
        const identity = { harness: "claude", directory };
        const { target: sessionTarget } = await runtime.createSession(
            {
                ...identity,
                configurations: [],
                computerId: runtime.computerId,
                operationId: crypto.randomUUID(),
            },
            signal,
        );
        await (await runtime.sessionClient(sessionTarget, signal)).turns.submit(
            sessionTarget,
            {
                content: "Remember the long workspace conversation",
                idempotencyKey: `turn-${crypto.randomUUID()}`,
                attachments: [],
            },
            signal,
        );
        expect(await runtime.api.managedSessions(signal)).toContainEqual(
            expect.objectContaining({ target: sessionTarget, directory, directoryLabel: canonical, prompted: true }),
        );
        const discovery = await runtime.api.nativeSessions({ ...identity, action: "list", cursor: null }, signal);
        if (discovery.action !== "list" || discovery.entries[0] === undefined) {
            throw new Error("Missing native conversation in the long workspace");
        }
        expect(discovery.entries[0]).toMatchObject({
            sessionId: sessionTarget.sessionId,
            directory,
            directoryLabel: canonical,
        });
        const events = await runtime.api.nativeSession(
            { harness: sessionTarget.harness, sessionId: sessionTarget.sessionId, directory: directory },
            signal,
        );
        expect(JSON.stringify(events)).toContain("Remember the long workspace conversation");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

it("Given a Session in a selected workspace, When the App prompts it and reads its execution naming only the Session, Then the Computer runs the Turn in the Session's own workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "morty-session-workspace-"));
    try {
        const directoryLabel = await realpath(workspace);
        const directory = directoryLabel;
        await using relay = await startTestRelay();
        const signal = AbortSignal.timeout(30_000);
        const owner = await relay.createOwner();
        const runtime = await relay.connectAgent(owner.computerId);
        const { target: sessionTarget } = await runtime.createSession(
            {
                harness: "claude",
                configurations: [],
                directory,
                computerId: runtime.computerId,
                operationId: crypto.randomUUID(),
            },
            signal,
        );
        const session = await runtime.sessionClient(sessionTarget, signal);
        onTestFinished(() => session.close());

        const turn = await session.turns.submit(
            sessionTarget,
            {
                attachments: [],
                content: "Remember the selected workspace",
                idempotencyKey: `turn-${crypto.randomUUID()}`,
            },
            signal,
        );
        await expect(session.sessions.readSessionExecution(sessionTarget, signal, turn.turnId)).resolves.toHaveProperty(
            "command",
        );

        expect(await runtime.api.managedSessions(signal)).toContainEqual(
            expect.objectContaining({
                directory,
                directoryLabel,
                prompted: true,
                target: sessionTarget,
                title: "Remember the selected workspace",
            }),
        );
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});
