import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as v from "valibot";
import { afterAll, expect, it } from "vitest";
import { IdentityStorage } from "../../src/computer-relay/components/management/storage/identity-storage.ts";
import { DurableObjectDatabase } from "../../src/computer-relay/infra/durable-object-database.ts";
import { computerObjectName } from "../../src/contracts/computer-id.ts";
import { createOwner, ownerOrigin, ownerRequest } from "./owner-fixture.ts";

afterAll(abortAllDurableObjects);

it("Given the computer's credential was replaced while a request to end other access waited, When that request writes, Then it ends nothing and the successor keeps its access", async ({
    signal,
}) => {
    const owner = await createOwner(signal);
    const successor = `${owner.token}-successor`;
    await runInDurableObject(
        env.COMPUTER_RELAY.getByName(computerObjectName(owner.computerId)),
        async (_instance, state) => {
            const identities = new IdentityStorage(new DurableObjectDatabase(state.storage), owner.computerId);
            expect(await identities.revokeAllAccess(owner.token, successor, Date.now(), signal)).toBe(true);

            expect(await identities.revokeOtherAccess(owner.token, Date.now(), signal)).toBe(false);
            expect(await identities.endOtherBrowserAccess(owner.token, null, Date.now(), signal)).toBe(false);

            expect(await identities.findCredential(successor, Date.now(), signal)).toMatchObject({ held: true });
        },
    );
});

async function joinBrowser(computerId: string, ownerToken: string, label: string): Promise<string> {
    const api = (path: string, body: object) =>
        ownerRequest(
            new Request(`${ownerOrigin}/morty/api/${path}`, {
                method: "POST",
                headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
                body: JSON.stringify(body),
            }),
        );
    const shared = await api(`v1/computers/${computerId}/identity/transfers`, { operationId: crypto.randomUUID() });
    const { url } = v.parse(v.object({ url: v.string() }), await shared.json());
    const redeemed = await api("v1/identity/transfers/redeem", { code: new URL(url).hash.slice(6), device: label });
    return v.parse(v.object({ computerToken: v.string() }), await redeemed.json()).computerToken;
}

it("Given a browser whose device was ended while its request to end another device waited, When that request writes, Then it ends nothing and the other device keeps its access", async ({
    signal,
}) => {
    const owner = await createOwner(signal);
    const stale = await joinBrowser(owner.computerId, owner.token, "Ended browser");
    const other = await joinBrowser(owner.computerId, owner.token, "Other browser");
    await runInDurableObject(
        env.COMPUTER_RELAY.getByName(computerObjectName(owner.computerId)),
        async (_instance, state) => {
            const identities = new IdentityStorage(new DurableObjectDatabase(state.storage), owner.computerId);
            const staleCredential = await identities.findCredential(stale, Date.now(), signal);
            const otherCredential = await identities.findCredential(other, Date.now(), signal);
            if (staleCredential?.kind !== "browser" || otherCredential?.kind !== "browser") {
                throw new Error("Expected both browsers to have joined");
            }
            expect(await identities.endDeviceAccess(owner.token, staleCredential.deviceId, Date.now(), signal)).toEqual(
                { kind: "ended" },
            );

            expect(await identities.endDeviceAccess(stale, otherCredential.deviceId, Date.now(), signal)).toEqual({
                kind: "callerEnded",
            });

            expect(await identities.findCredential(other, Date.now(), signal)).toMatchObject({
                accessHeldUntil: expect.any(Number),
            });
            expect(await identities.endDeviceAccess(owner.token, "device_missing", Date.now(), signal)).toEqual({
                kind: "unknown",
            });
        },
    );
});
