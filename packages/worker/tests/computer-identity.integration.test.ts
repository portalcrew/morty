import * as v from "valibot";
import { afterAll, beforeAll, expect, test } from "vitest";
import worker from "../src/worker/application.ts";
import { APP_ORIGIN, anonymousCreationKey, createIdentityFixture } from "./support/identity-fixture.ts";

let fixture: Awaited<ReturnType<typeof createIdentityFixture>>;

beforeAll(async () => {
    fixture = await createIdentityFixture();
});

afterAll(async () => {
    await fixture.close();
});

test("Given a new Computer, When setup creates and shares its access, Then each response contains only its Computer ID and Computer token and cannot open another Computer", async () => {
    const create = async (creationKey: string) => {
        const response = await worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/v1/computers`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ creationKey }),
            }),
            fixture.environment(),
        );
        expect(response.status).toBe(201);
        return v.parse(v.strictObject({ computerId: v.string(), computerToken: v.string() }), await response.json());
    };
    const key = anonymousCreationKey();
    const first = await create(key);
    expect((await create(key)).computerId).not.toBe(first.computerId);
    const second = await create(anonymousCreationKey());
    const session = (computerId: string) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/v1/computers/${computerId}/session`, {
                headers: { authorization: `Bearer ${first.computerToken}` },
            }),
            fixture.environment(),
        );
    const opened = await session(first.computerId);
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({ computerId: first.computerId });
    expect((await session(second.computerId)).status).toBe(401);

    const shared = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/v1/computers/${first.computerId}/identity/transfers`, {
            method: "POST",
            headers: { authorization: `Bearer ${first.computerToken}`, "content-type": "application/json" },
            body: JSON.stringify({ operationId: crypto.randomUUID() }),
        }),
        fixture.environment(),
    );
    expect(shared.status).toBe(201);
    const link = v.parse(v.object({ url: v.string() }), await shared.json()).url;
    const code = new URLSearchParams(new URL(link).hash.slice(1)).get("code");
    const redeemed = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/v1/identity/transfers/redeem`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code }),
        }),
        fixture.environment(),
    );
    expect(redeemed.status).toBe(200);
    const browser = v.parse(
        v.strictObject({ computerId: v.string(), computerToken: v.string() }),
        await redeemed.json(),
    );
    expect(browser.computerId).toBe(first.computerId);
    expect(browser.computerToken).not.toBe(first.computerToken);
    for (const [computerId, expected] of [
        [first.computerId, 200],
        [second.computerId, 401],
    ] as const) {
        const response = await worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/v1/computers/${computerId}/session`, {
                headers: { authorization: `Bearer ${browser.computerToken}` },
            }),
            fixture.environment(),
        );
        expect(response.status).toBe(expected);
    }
});
