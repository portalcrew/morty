import * as v from "valibot";
import { computerManagementSchema, relayIdentifier } from "./computer-management.ts";

/**
 * Why a computer is bootstrapped. A created computer is bootstrapped once, by the request that created it; a replacement
 * may be repeated, so its credential derives from the predecessor that names it.
 */
const bootstrapOrigin = v.variant("kind", [
    v.pipe(v.object({ kind: v.literal("created") }), v.readonly()),
    // Only the internal replacement path supplies the authenticated predecessor identity.
    v.pipe(
        v.object({
            kind: v.literal("replacement"),
            previousComputerId: relayIdentifier,
            token: v.pipe(v.string(), v.regex(/^morty_computer_v1_[A-Za-z0-9_-]{43}$/u)),
        }),
        v.readonly(),
    ),
]);

export type BootstrapOrigin = v.InferOutput<typeof bootstrapOrigin>;

export const computerBootstrap = v.pipe(
    v.object({
        computer: computerManagementSchema,
        origin: bootstrapOrigin,
    }),
    v.readonly(),
);
