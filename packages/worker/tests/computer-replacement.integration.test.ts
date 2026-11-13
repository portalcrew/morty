import { fileURLToPath } from "node:url";
import * as v from "valibot";
import { afterAll, beforeAll, expect, test } from "vitest";
import worker from "../src/worker/application.ts";
import { APP_ORIGIN, createIdentityFixture } from "./support/identity-fixture.ts";

const replacementSchema = v.object({
    computerId: v.string(),
    computerToken: v.pipe(v.string(), v.regex(/^morty_computer_v1_[A-Za-z0-9_-]{43}$/u)),
});

const replacementAccess = v.pipe(
    replacementSchema,
    v.transform(({ computerId, computerToken }) => ({ computerId, token: computerToken })),
);

let fixture: Awaited<ReturnType<typeof createIdentityFixture>>;

beforeAll(async () => {
    fixture = await createIdentityFixture({
        workerEntryPoint: fileURLToPath(new URL("./support/credential-storage-worker.ts", import.meta.url)),
    });
});

afterAll(async () => {
    await fixture.close();
});

test("Given a saved Computer, When it is replaced, Then setup receives a fresh Computer and credential", async () => {
    const environment = fixture.environment();
    const original = await fixture.createAnonymousUser();
    const replace = async () =>
        await worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/v1/computers/${original.computerId}/replacement`, {
                method: "POST",
                headers: { authorization: `Bearer ${original.token}` },
            }),
            environment,
        );

    const response = await replace();
    expect(response.status).toBe(201);
    const replacement = v.parse(replacementAccess, await response.json());
    expect(replacement.computerId).not.toBe(original.computerId);
    expect(replacement.token).not.toBe(original.token);

    const retryResponse = await replace();
    expect(retryResponse.status).toBe(201);
    const retry = v.parse(replacementAccess, await retryResponse.json());
    expect(retry.computerId).toBe(replacement.computerId);
    expect(retry.token).toBe(replacement.token);

    const sessionResponse = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/v1/computers/${replacement.computerId}/session`, {
            headers: { authorization: `Bearer ${replacement.token}` },
        }),
        environment,
    );
    expect(sessionResponse.status).toBe(200);

    const previousCredential = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/v1/computers/${replacement.computerId}/session`, {
            headers: { authorization: `Bearer ${original.token}` },
        }),
        environment,
    );
    expect(previousCredential.status).toBe(401);

    const computerResponse = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/v1/computers/${replacement.computerId}/pairing-state`, {
            headers: { authorization: `Bearer ${replacement.token}` },
        }),
        environment,
    );
    expect(computerResponse.status).toBe(200);
    expect(await computerResponse.json()).toEqual({ computerPairing: "unpaired" });
});

test("Given a revoked successor local credential, When the previous Computer retries replacement, Then it cannot reactivate that credential", async () => {
    const original = await fixture.createAnonymousUser();
    const replace = () =>
        worker.fetch(
            computerRequest(original.computerId, "/replacement", original.token, "POST"),
            fixture.environment(),
        );
    const response = await replace();
    expect(response.status).toBe(201);
    const replacement = v.parse(replacementAccess, await response.json());
    expect(
        (
            await worker.fetch(
                computerRequest(replacement.computerId, "/identity/local-credential", replacement.token, "DELETE"),
                fixture.environment(),
            )
        ).status,
    ).toBe(204);
    const retry = await replace();
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ error: { code: "LOCAL_CREDENTIAL_UNAVAILABLE" } });
    expect(
        (
            await worker.fetch(
                computerRequest(replacement.computerId, "/session", replacement.token),
                fixture.environment(),
            )
        ).status,
    ).toBe(401);
});

function computerRequest(computerId: string, path: string, token: string, method = "GET", body?: object): Request {
    return new Request(`${APP_ORIGIN}/morty/api/v1/computers/${computerId}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

test("Given a completed replacement, When the saved Computer retries after a Worker restart, Then setup receives the same credential and a usable Computer", async () => {
    const original = await fixture.createAnonymousUser();
    const replace = () =>
        worker.fetch(
            computerRequest(original.computerId, "/replacement", original.token, "POST"),
            fixture.environment(),
        );
    const response = await replace();
    expect(response.status).toBe(201);
    const issued = v.parse(replacementAccess, await response.json());
    // Restart with durable storage intact before retrying the replacement.
    await fixture.reload();

    const retry = await replace();
    expect(retry.status).toBe(201);
    const completed = v.parse(replacementAccess, await retry.json());
    expect(completed.token).toBe(issued.token);
    expect(completed.computerId).toBe(issued.computerId);
    expect(
        (await worker.fetch(computerRequest(completed.computerId, "/session", completed.token), fixture.environment()))
            .status,
    ).toBe(200);
    expect(
        (
            await worker.fetch(
                computerRequest(completed.computerId, "/pairing-state", completed.token),
                fixture.environment(),
            )
        ).status,
    ).toBe(200);
});

async function share(computerId: string, token: string): Promise<string> {
    const response = await worker.fetch(
        computerRequest(computerId, "/identity/transfers", token, "POST", { operationId: crypto.randomUUID() }),
        fixture.environment(),
    );
    expect(response.status).toBe(201);
    return new URL(v.parse(v.object({ url: v.string() }), await response.json()).url).hash.slice("#code=".length);
}

async function redeem(code: string): Promise<Response> {
    return await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/v1/identity/transfers/redeem`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code }),
        }),
        fixture.environment(),
    );
}

test("Given access shared from a saved Computer, When it is replaced, Then nothing shared before opens the previous Computer and the local identity can still repeat the replacement", async () => {
    const original = await fixture.createAnonymousUser();
    const redeemed = await redeem(await share(original.computerId, original.token));
    expect(redeemed.status).toBe(200);
    const browser = v.parse(v.object({ computerToken: v.string() }), await redeemed.json()).computerToken;
    const unredeemed = await share(original.computerId, original.token);

    const replace = async () =>
        await worker.fetch(
            computerRequest(original.computerId, "/replacement", original.token, "POST"),
            fixture.environment(),
        );
    const response = await replace();
    expect(response.status).toBe(201);
    const replacement = v.parse(replacementAccess, await response.json());

    expect(
        (await worker.fetch(computerRequest(original.computerId, "/session", browser), fixture.environment())).status,
    ).toBe(401);
    expect((await redeem(unredeemed)).status).toBe(410);
    // A reply the local identity never received can be asked for again.
    const retry = await replace();
    expect(retry.status).toBe(201);
    expect(v.parse(replacementSchema, await retry.json()).computerId).toBe(replacement.computerId);
});

test("Given a browser that opened a shared link, When it asks to replace the Computer, Then only the computer's own identity may", async () => {
    const original = await fixture.createAnonymousUser();
    const redeemed = await redeem(await share(original.computerId, original.token));
    const browser = v.parse(v.object({ computerToken: v.string() }), await redeemed.json()).computerToken;

    const response = await worker.fetch(
        computerRequest(original.computerId, "/replacement", browser, "POST"),
        fixture.environment(),
    );

    expect(response.status).toBe(403);
    expect(
        (await worker.fetch(computerRequest(original.computerId, "/session", original.token), fixture.environment()))
            .status,
    ).toBe(200);
});

test("Given an unauthenticated request, When a Computer replacement is requested, Then it is rejected", async () => {
    const identity = await fixture.createAnonymousUser();
    const response = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/v1/computers/${identity.computerId}/replacement`, {
            method: "POST",
        }),
        fixture.environment(),
    );
    expect(response.status).toBe(401);
});
