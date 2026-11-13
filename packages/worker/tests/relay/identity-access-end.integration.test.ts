import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, expect, it } from "vitest";
import { IdentityStorage } from "../../src/computer-relay/components/management/storage/identity-storage.ts";
import { DurableObjectDatabase } from "../../src/computer-relay/infra/durable-object-database.ts";
import { computerObjectName } from "../../src/contracts/computer-id.ts";
import { createOwner } from "./owner-fixture.ts";

afterAll(abortAllDurableObjects);

it("Given the computer's credential was replaced while a request to end other access waited, When that request writes, Then it ends nothing and the successor keeps its access", async () => {
    const owner = await createOwner();
    const successor = `${owner.token}-successor`;
    await runInDurableObject(
        env.COMPUTER_RELAY.getByName(computerObjectName(owner.computerId)),
        async (_instance, state) => {
            const signal = AbortSignal.timeout(10_000);
            const identities = new IdentityStorage(new DurableObjectDatabase(state.storage), owner.computerId);
            // The request authorized with the credential, then another revoked all access and replaced it.
            expect(await identities.revokeAllAccess(owner.token, successor, Date.now(), signal)).toBe(true);

            expect(await identities.revokeOtherAccess(owner.token, Date.now(), signal)).toBe(false);
            expect(await identities.endOtherBrowserAccess(owner.token, null, Date.now(), signal)).toBe(false);

            expect(await identities.findCredential(successor, Date.now(), signal)).toMatchObject({ held: true });
        },
    );
});
