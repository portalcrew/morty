import * as v from "valibot";

export async function createTestOwner(
    request: (request: Request) => Promise<Response>,
    origin: string,
    signal: AbortSignal,
) {
    const response = await request(
        new Request(`${origin}/morty/api/v1/computers`, {
            method: "POST",
            signal,
        }),
    );
    if (response.status !== 201) {
        throw new Error(`Owner creation failed (${response.status}): ${await response.text()}`);
    }
    const identity = v.parse(v.object({ computerToken: v.string(), computerId: v.string() }), await response.json());
    return { computerId: identity.computerId, token: identity.computerToken };
}
