import { expect, test } from "vitest";
import { createIdentityFixture } from "./support/identity-fixture.ts";

test("Given a creation operation still applying initial settings, When another caller changes its inputs, Then the conflict is refused and a corrected retry after initialization fails creates a retained native Session", {
    timeout: 60000,
}, async () => {
    const cloud = await createIdentityFixture();
    const applying = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
        const identity = await cloud.createAnonymousUser();
        await using runtime = await cloud.connectAgent(identity.computerId, identity.token, [
            {
                harness: "configuration-test",
                label: "Settings Agent",
                beforeConfigurationApplied: async (configId, value) => {
                    if (configId === "model" && value === "test-large") {
                        applying.resolve();
                        await release.promise;
                    }
                },
            },
        ]);
        const signal = AbortSignal.timeout(30000);
        const operationId = crypto.randomUUID();
        const input = {
            harness: "configuration-test",
            directory: ".",
            operationId,
        };
        const refused = runtime
            .createSession(
                {
                    ...input,
                    configurations: [
                        { configId: "model", type: "select", value: "test-large" },
                        { configId: "missing-option", type: "select", value: "anything" },
                    ],
                },
                signal,
            )
            .then(
                (value) => ({ ok: true, value }),
                (cause) => ({ ok: false, cause }),
            );
        await applying.promise;
        try {
            await expect(runtime.createSession({ ...input, configurations: [] }, signal)).rejects.toMatchObject({
                code: "idempotency_conflict",
            });
        } finally {
            release.resolve();
        }
        expect(await refused).toMatchObject({ ok: false, cause: { code: "session_configuration_conflict" } });
        expect(await runtime.api.managedSessions(signal)).toEqual([]);
        const successful = await runtime.createSession({ ...input, configurations: [] }, signal);
        expect(successful.target.sessionId).not.toBe(operationId);
        expect(await runtime.api.managedSession(successful.target, signal)).toMatchObject({
            target: successful.target,
        });
    } finally {
        release.resolve();
        await cloud.close();
    }
});
