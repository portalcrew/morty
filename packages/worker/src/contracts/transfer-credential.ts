import * as v from "valibot";

const computerId = v.pipe(v.string(), v.regex(/^prj_(wn|ap|an|as)_01_[A-Za-z0-9_-]{24}$/u));
const secret = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/u));
const credentialKind = v.picklist(["morty_transfer_v1"]);
const credential = v.tuple([credentialKind, computerId, secret]);

export function readTransferCredential(value: unknown) {
    if (typeof value !== "string") {
        return null;
    }
    const parsed = v.safeParse(credential, value.split("."));
    if (!parsed.success) {
        return null;
    }
    const [, computerId] = parsed.output;
    return { computerId };
}

/** A sharing operation recovers its secret without storing a redeemable credential in the database. */
export async function sharingOperationCredential(
    requestedComputerId: string,
    issuerToken: string,
    operationId: string,
    signal: AbortSignal,
): Promise<string> {
    signal.throwIfAborted();
    const target = v.parse(computerId, requestedComputerId);
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(issuerToken),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const signed = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(JSON.stringify(["morty-sharing-operation-v1", target, operationId])),
    );
    signal.throwIfAborted();
    const value = btoa(String.fromCharCode(...new Uint8Array(signed)))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "");
    return `morty_transfer_v1.${target}.${value}`;
}
