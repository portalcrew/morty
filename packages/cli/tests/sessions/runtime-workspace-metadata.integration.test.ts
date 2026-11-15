import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startTestRelay } from "../support/relay.ts";

// @no-uc: Performance; validating a directory must not require enumerating its children.
it("describes a selected directory without browsing its children and still rejects unavailable directories", async ({
    signal,
}) => {
    const root = await mkdtemp(join(tmpdir(), "morty-workspace-metadata-"));
    try {
        await mkdir(join(root, "child"));
        const canonical = await realpath(root);
        const directory = canonical;
        await using relay = await startTestRelay(signal);
        const owner = await relay.createOwner();
        const runtime = await relay.connectAgent(owner.computerId);
        const listing = await runtime.api.directory(directory, signal);
        expect(listing.entries.map((entry) => entry.name)).toContain("child");

        await chmod(root, 0o111);
        const open = (workspaceRef: string) =>
            runtime.api.createConversation(
                crypto.randomUUID(),
                {
                    harness: "claude",
                    configurations: [],
                    workspaceRef,
                    workspaceLabel: workspaceRef,
                },
                signal,
            );
        expect((await open(directory)).workspaceRef).toBe(directory);
        await expect(open(join(canonical, "missing"))).rejects.toMatchObject({
            code: "local_authorization_failed",
        });
    } finally {
        await chmod(root, 0o755);
        await rm(root, { recursive: true, force: true });
    }
});
