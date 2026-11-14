import { expect, it } from "vitest";
import { startTestRelay } from "../support/relay.ts";

it("Given a prompted local conversation, When the Session is renamed, Then the directory and the controlled Agent show the new title", async () => {
    const cancellation = new AbortController();
    await using relay = await startTestRelay();
    try {
        const owner = await relay.createOwner();
        const runtime = await relay.connectAgent(owner.computerId);
        const { target: sessionTarget } = await runtime.createSession(
            {
                harness: "claude",
                configurations: [],
                directory: ".",
                operationId: crypto.randomUUID(),
            },
            cancellation.signal,
        );
        await (await runtime.sessionClient(sessionTarget, cancellation.signal)).turns.submit(
            sessionTarget,
            {
                content: "Remember this conversation",
                idempotencyKey: `turn-${crypto.randomUUID()}`,
                attachments: [],
            },
            cancellation.signal,
        );

        await expect(
            (await runtime.sessionClient(sessionTarget, cancellation.signal)).sessions.rename(
                sessionTarget,
                "Renamed by the developer",
                cancellation.signal,
            ),
        ).resolves.toEqual(
            expect.objectContaining({
                kind: "session.renamed",
                target: sessionTarget,
                title: "Renamed by the developer",
            }),
        );

        await expect(runtime.api.managedSessions(cancellation.signal)).resolves.toEqual([
            expect.objectContaining({
                prompted: true,
                target: sessionTarget,
                status: { kind: "idle" },
                title: "Renamed by the developer",
            }),
        ]);

        // The controlled Agent harness received the rename: its own native
        // Session listing reports the new title instead of the first prompt.
        const discovery = await runtime.api.nativeSessions(
            {
                action: "list",
                harness: "claude",
                cursor: null,
                directory: ".",
            },
            cancellation.signal,
        );
        expect(discovery).toEqual(
            expect.objectContaining({
                action: "list",
                entries: expect.arrayContaining([
                    expect.objectContaining({
                        sessionId: sessionTarget.sessionId,
                        title: "Renamed by the developer",
                    }),
                ]),
            }),
        );
    } finally {
        cancellation.abort(new Error("Computer Session rename test completed"));
    }
});
