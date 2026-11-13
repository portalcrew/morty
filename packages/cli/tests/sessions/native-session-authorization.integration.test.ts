import { mkdir, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { NativeSessionCommand, NativeSessionEntry } from "@morty-build/client/protocol";
import { describe, expect, it } from "vitest";

import { fixture } from "./native-session-fixture.ts";

describe("native session authorization", () => {
    it.each(["Claude Code"] as const)(
        "Given %s has saved conversations across projects, When they are listed and imported, Then pagination includes other directories and imports retain their original project and Morty identity",
        async (label) => {
            const f = await fixture(label);
            try {
                const outside = join(f.temporary, "outside");
                await mkdir(outside);
                await f.seed("Saved one");
                await f.seed("Saved two");
                await f.seed("Saved three");
                await f.seed("Other project", outside);
                const entries: NativeSessionEntry[] = [];
                let cursor: string | null = null;
                do {
                    const page = await f.list(cursor);
                    entries.push(...page.entries);
                    cursor = page.nextCursor;
                } while (cursor !== null);
                expect(entries.map((entry) => entry.title).sort()).toEqual([
                    "Other project",
                    "Saved one",
                    "Saved three",
                    "Saved two",
                ]);
                const entry = entries.find((entry) => entry.title === "Other project");
                if (entry === undefined) {
                    throw new Error("Missing native conversation");
                }
                const command = {
                    ...f.identity,
                    action: "import",
                    directory: entry.directory,
                    sessionId: entry.sessionId,
                } satisfies NativeSessionCommand;
                const first = await f.service.execute(command, new AbortController().signal);
                expect(first).toMatchObject({
                    action: "import",
                    target: { harness: f.agent.harness, sessionId: entry.sessionId },
                    ready: {
                        restored: true,
                        directory: entry.directory,
                        directoryLabel: entry.directoryLabel,
                        capabilities: {
                            listSessions: true,
                            deleteSession: true,
                            unstableForkSession: true,
                        },
                    },
                });
                expect(await f.service.execute(command, new AbortController().signal)).toMatchObject({
                    target: { harness: f.agent.harness, sessionId: entry.sessionId },
                });
                await expect(
                    f.service.execute({ ...command, sessionId: "forged" }, new AbortController().signal),
                ).rejects.toMatchObject({ code: "native_session_not_found" });
                await expect(f.list("forged-cursor")).rejects.toMatchObject({
                    code: "native_session_cursor_expired",
                });
            } finally {
                await f.close();
            }
        },
    );

    it("Given paginated native sessions, When one is found by its native ID, Then its authorized entry exposes the ID for direct Chat ownership", async () => {
        const f = await fixture("Claude Code");
        try {
            await f.seed("Earlier conversation");
            await f.seed("Another conversation");
            const sessionId = await f.seed("Current handoff conversation");
            const found = await f.service.execute(
                { ...f.identity, action: "find", sessionId },
                new AbortController().signal,
            );
            expect(found).toMatchObject({
                action: "find",
                entry: { title: "Current handoff conversation" },
            });
            expect(found).toMatchObject({ entry: { sessionId } });
            if (found.action !== "find") {
                throw new Error("Expected a native session lookup");
            }
            await expect(
                f.service.execute(
                    {
                        ...f.identity,
                        action: "import",
                        sessionId: found.entry.sessionId,
                    },
                    new AbortController().signal,
                ),
            ).resolves.toMatchObject({
                action: "import",
                target: { harness: f.agent.harness, sessionId },
            });
        } finally {
            await f.close();
        }
    });

    it("Given a listed session uses a linked directory, When that directory changes before import, Then the local boundary requires a refreshed selection before importing the session", async () => {
        const f = await fixture("Claude Code");
        try {
            const inside = join(f.workspace, "inside");
            const outside = join(f.temporary, "outside");
            const alias = join(f.workspace, "alias");
            await mkdir(inside);
            await mkdir(outside);
            await symlink(inside, alias);
            await f.seed("Moving workspace", alias);
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            await rm(alias);
            await symlink(outside, alias);
            await expect(
                f.service.execute(
                    { ...f.identity, directory: entry.directory, action: "import", sessionId: entry.sessionId },
                    new AbortController().signal,
                ),
            ).rejects.toMatchObject({ code: "native_session_target_changed" });
            expect((await readdir(f.native)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
            expect((await f.list()).entries).toEqual([expect.objectContaining({ title: "Moving workspace" })]);
        } finally {
            await f.close();
        }
    });

    it("Given an Agent omits native session capabilities, When a remote caller requests its sessions, Then the local boundary rejects the operation", async () => {
        const f = await fixture("Claude Code", "unsupported");
        try {
            const ready = await f.sessions.prepareSession({
                agent: f.agent,
                cwd: f.workspace,
                target: await f.sessions.createNativeSession({
                    agent: f.agent,
                    cwd: f.workspace,
                    signal: AbortSignal.timeout(10_000),
                }),
                signal: new AbortController().signal,
            });
            expect(ready.capabilities).toMatchObject({
                listSessions: false,
                deleteSession: false,
                unstableForkSession: false,
            });
            await expect(f.list()).rejects.toMatchObject({
                code: "native_session_unsupported",
            });
        } finally {
            await f.close();
        }
    });
});
