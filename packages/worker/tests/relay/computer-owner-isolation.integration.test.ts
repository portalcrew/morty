import { abortAllDurableObjects } from "cloudflare:test";
import { afterAll, expect, it } from "vitest";
import { createOwner, ownerOrigin, ownerRequest } from "./owner-fixture.ts";

afterAll(abortAllDurableObjects);
it("Given two computer owners, When one uses the other's computer management boundary, Then access is denied while its own computer remains available", async () => {
    const owner = await createOwner();
    const other = await createOwner();
    const read = (computerId: string, token: string) =>
        ownerRequest(
            new Request(`${ownerOrigin}/morty/api/v1/computers/${computerId}`, {
                headers: { authorization: `Bearer ${token}` },
            }),
        );
    expect((await read(owner.computerId, other.token)).status).toBe(401);
    expect((await read(other.computerId, owner.token)).status).toBe(401);
    expect((await read(owner.computerId, owner.token)).status).toBe(200);
    expect((await read(other.computerId, other.token)).status).toBe(200);
});
