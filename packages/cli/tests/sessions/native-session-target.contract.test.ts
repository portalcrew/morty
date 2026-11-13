import { expect, it, vi } from "vitest";
import { startTestRelay } from "../support/relay.ts";

it("Given two harnesses create conversations, When I restore each conversation, Then both native pairs remain independently usable", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-07T00:00:00.000Z"));
    try {
        await using relay = await startTestRelay();
        const signal = AbortSignal.timeout(30_000);
        const owner = await relay.createOwner();
        const runtime = await relay.connectAgent(
            owner.computerId,
            ["claude", "codex"].map((harness) => ({
                harness,
                label: harness,
                isolatedNativeStorage: true,
                arguments: ["--persist-empty-sessions"],
            })),
        );
        const targets: { readonly harness: string; readonly sessionId: string }[] = [];
        for (const harness of ["claude", "codex"]) {
            const ready = await runtime.createSession(
                {
                    harness: harness,

                    configurations: [],
                    directory: ".",
                    computerId: runtime.computerId,
                    operationId: crypto.randomUUID(),
                },
                signal,
            );
            expect(ready.target.harness).toBe(harness);
            targets.push(ready.target);
        }
        expect(targets[0]?.harness).not.toBe(targets[1]?.harness);
        for (const target of targets) {
            await expect(runtime.api.managedSession(target, signal)).resolves.toMatchObject({
                target,
            });
        }
    } finally {
        vi.useRealTimers();
    }
});

it("Given a harness announces its title during creation, When the caller creates a Session and lists it, Then its native conversation retains that title without an intermediate Morty identity", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-07T00:00:00.000Z"));
    try {
        await using relay = await startTestRelay();
        const signal = AbortSignal.timeout(30_000);
        const owner = await relay.createOwner();
        const runtime = await relay.connectAgent(owner.computerId, [
            {
                harness: "claude",
                label: "Controlled ACP",
                arguments: ["--announce-title-while-creating"],
            },
        ]);
        const ready = await runtime.createSession(
            {
                harness: "claude",

                configurations: [],
                directory: ".",
                computerId: runtime.computerId,
                operationId: crypto.randomUUID(),
            },
            signal,
        );
        const entries = await runtime.api.managedSessions(signal);
        expect(entries).toMatchObject([
            {
                target: ready.target,
                title: "Harness-created conversation",
            },
        ]);
    } finally {
        vi.useRealTimers();
    }
});

it("Given two harnesses own the same native session ID without prior discovery, When a caller imports and restores each native pair without a binding identity, Then each selects only its harness and a different harness cannot select either", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-07T00:00:00.000Z"));
    try {
        await using relay = await startTestRelay();
        const signal = AbortSignal.timeout(30_000);
        const owner = await relay.createOwner();
        const sessionId = "same-native-session";
        const runtime = await relay.connectAgent(
            owner.computerId,
            [
                { harness: "claude", label: "Claude Code" },
                { harness: "codex", label: "Codex" },
            ],
            new Set([sessionId]),
        );
        const imported = new Map<string, string>();
        for (const harness of ["claude", "codex"]) {
            const workspace = { harness: harness, directory: "." };
            const opened = await runtime.api.nativeSessions(
                {
                    ...workspace,
                    action: "import",
                    sessionId,
                },
                signal,
            );
            if (opened.action !== "import") {
                throw new Error("Expected native session import");
            }
            imported.set(harness, opened.target.sessionId);
        }
        for (const harness of ["claude", "codex"]) {
            const target = { harness, sessionId };
            await expect(runtime.api.managedSession(target, signal)).resolves.toMatchObject({
                target: { harness, sessionId: imported.get(harness) },
            });
        }
        await expect(
            runtime.api.managedSession(
                {
                    harness: "pi",
                    sessionId,
                },
                signal,
            ),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
        vi.useRealTimers();
    }
});
