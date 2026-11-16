import * as v from "valibot";
import { relayIdentifier } from "./computer-management.ts";
import { COMPUTER_INTERNAL_PREFIX } from "./computer-relay-http.ts";

/**
 * Why a computer is created. A created computer is created once, by the request that names it; a replacement may be
 * repeated, so its credential derives from the predecessor that names it.
 */
const creationOrigin = v.variant("kind", [
    v.pipe(v.object({ kind: v.literal("created") }), v.readonly()),
    v.pipe(
        v.object({
            kind: v.literal("replacement"),
            previousComputerId: relayIdentifier,
            token: v.pipe(v.string(), v.regex(/^morty_computer_v1_[A-Za-z0-9_-]{43}$/u)),
        }),
        v.readonly(),
    ),
]);

export type CreationOrigin = v.InferOutput<typeof creationOrigin>;

export const computerCreation = v.pipe(v.object({ origin: creationOrigin }), v.readonly());

export function computerCreationRequest(computerId: string, origin: CreationOrigin, signal: AbortSignal): Request {
    return new Request(
        new URL(`${COMPUTER_INTERNAL_PREFIX}/${encodeURIComponent(computerId)}`, "https://computer.internal"),
        {
            body: JSON.stringify({ origin }),
            headers: { "content-type": "application/json" },
            method: "POST",
            signal,
        },
    );
}
