import { MortyError } from "@morty-build/client";
import { expect, it } from "vitest";
import { startTestRelay } from "../support/relay.ts";

it("Given two clients holding one configuration revision, When they edit concurrently, Then only one edit commits and a stale retry cannot overwrite it", async () => {
    const cancellation = new AbortController();
    await using relay = await startTestRelay();
    try {
        const owner = await relay.createOwner();
        const runtime = await relay.connectAgent(owner.computerId);
        const ready = await runtime.createSession(
            {
                harness: "claude",
                configurations: [],
                directory: ".",
                computerId: runtime.computerId,
                operationId: crypto.randomUUID(),
            },
            cancellation.signal,
        );
        expect(ready.configurationRevision).toEqual(expect.any(String));
        const edit = {
            configId: "model",
            expectedConfigurationRevision: ready.configurationRevision,
            value: "test-large",
            type: "select" as const,
        };
        const results = await Promise.allSettled([
            (await runtime.sessionClient(ready.target, cancellation.signal)).sessions.updateConfiguration(
                ready.target,
                edit,
                cancellation.signal,
            ),
            (await runtime.sessionClient(ready.target, cancellation.signal)).sessions.updateConfiguration(
                ready.target,
                { ...edit, value: "test-small" },
                cancellation.signal,
            ),
        ]);
        const accepted = results.filter((result) => result.status === "fulfilled");
        expect(accepted).toHaveLength(1);
        const rejected = results.filter((result) => result.status === "rejected");
        expect(rejected).toHaveLength(1);
        expect(rejected[0]?.reason).toBeInstanceOf(MortyError);
        expect(rejected[0]?.reason).toMatchObject({ code: "session_configuration_conflict" });
        // This is an authenticated Computer operation failure, not an HTTP failure
        // synthesized by the Worker from private configuration data.
        expect(rejected[0]?.reason).not.toHaveProperty("status");
        const committed = accepted[0];
        if (committed === undefined) {
            throw new Error("One configuration edit must commit");
        }
        expect(committed.value.configurationRevision).not.toBe(ready.configurationRevision);
        await expect(
            (await runtime.sessionClient(ready.target, cancellation.signal)).sessions.updateConfiguration(
                ready.target,
                edit,
                cancellation.signal,
            ),
        ).rejects.toMatchObject({ code: "session_configuration_conflict" });
        const current = await (
            await runtime.sessionClient(ready.target, cancellation.signal)
        ).sessions.readConfiguration(ready.target, cancellation.signal);
        expect(current.configOptions).toEqual(committed.value.configOptions);
        expect(current.configurationRevision).toBe(committed.value.configurationRevision);
    } finally {
        cancellation.abort();
    }
});
