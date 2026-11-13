import { createResponseLossProxy } from "@morty-build/relay-test-support/response-loss-proxy";
import * as v from "valibot";
import { expect, test } from "vitest";
import worker from "../src/worker/application.ts";
import { APP_ORIGIN, accountRequest, createIdentityFixture } from "./support/identity-fixture.ts";

test("Given a computer owner, When the owner opens management, Then they can pair a Computer for their account", async () => {
    const fixture = await createIdentityFixture();
    try {
        const identity = await fixture.createAnonymousUser();
        const managementUrl = `${APP_ORIGIN}/morty/api/v1/computers/${identity.computerId}`;
        const headers = { authorization: `Bearer ${identity.token}` };

        const environment = fixture.environment();

        const computer = await worker.fetch(new Request(managementUrl, { headers }), environment);
        expect(computer.status).toBe(200);
        expect(await computer.json()).toMatchObject({ computer: { computerId: identity.computerId } });
        const pairing = await worker.fetch(
            new Request(`${managementUrl}/pairing`, {
                method: "POST",
                headers: { ...headers, "content-type": "application/json" },
                body: JSON.stringify({ idempotencyKey: "reconfigured-service-pairing" }),
            }),
            environment,
        );
        expect(pairing.status).toBe(201);
        expect(await pairing.json()).toMatchObject({ computerId: identity.computerId });
    } finally {
        await fixture.close();
    }
});

test("Given an existing Computer, When Morty moves to another origin, Then the user keeps their Computer and can pair and replace it", {
    timeout: 30_000,
}, async () => {
    const fixture = await createIdentityFixture();
    try {
        const identity = await fixture.createAnonymousUser();
        const managementUrl = `${APP_ORIGIN}/morty/api/v1/computers/${identity.computerId}`;
        const headers = { authorization: `Bearer ${identity.token}` };
        const originalComputer = await worker.fetch(new Request(managementUrl, { headers }), fixture.environment());
        expect(originalComputer.status).toBe(200);
        const computer = await originalComputer.json();
        const originalBot = await worker.fetch(
            new Request(`${managementUrl}/pairing-state`, { headers }),
            fixture.environment(),
        );
        expect(originalBot.status).toBe(200);
        const bot = await originalBot.json();

        // A second listener forwards to the same real Relay and its existing storage.
        const relocated = await createResponseLossProxy(fixture.origin);
        try {
            await fixture.changeAppOrigin(relocated.origin);
            const environment = fixture.environment();
            const session = await worker.fetch(accountRequest(identity.token, identity.computerId), environment);
            expect(session.status).toBe(200);
            expect(await session.json()).toMatchObject({ computerId: identity.computerId });
            const currentBot = await worker.fetch(
                new Request(`${managementUrl}/pairing-state`, { headers }),
                environment,
            );
            expect(currentBot.status).toBe(200);
            expect(await currentBot.json()).toEqual(bot);
            const currentComputer = await worker.fetch(new Request(managementUrl, { headers }), environment);
            expect(currentComputer.status).toBe(200);
            expect(await currentComputer.json()).toEqual(computer);

            const pairing = await worker.fetch(
                new Request(`${managementUrl}/pairing`, {
                    method: "POST",
                    headers: { ...headers, "content-type": "application/json" },
                    body: JSON.stringify({ idempotencyKey: "relocated-relay-pairing" }),
                }),
                environment,
            );
            expect(pairing.status).toBe(201);
            expect(await pairing.json()).toMatchObject({ computerId: identity.computerId, relayUrl: relocated.origin });

            const replaced = await worker.fetch(
                new Request(`${managementUrl}/replacement`, {
                    method: "POST",
                    headers,
                }),
                environment,
            );
            expect(replaced.status).toBe(201);
            const replacement = v.parse(
                v.object({ computerId: v.string(), computerToken: v.string() }),
                await replaced.json(),
            );
            expect(replacement.computerId).not.toBe(identity.computerId);
            expect(
                (await worker.fetch(accountRequest(replacement.computerToken, replacement.computerId), environment))
                    .status,
            ).toBe(200);
        } finally {
            await relocated.close();
        }
    } finally {
        await fixture.close();
    }
});
