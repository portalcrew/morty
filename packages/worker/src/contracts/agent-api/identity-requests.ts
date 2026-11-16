import * as v from "valibot";

export const transferRedemptionInput = v.pipe(
    v.object({
        code: v.pipe(v.string(), v.description("The `code` from the continue link's URL fragment.")),
        replaces: v.optional(v.pipe(v.string(), v.maxLength(512))),
        device: v.optional(
            v.pipe(
                v.string(),
                v.trim(),
                v.regex(/^[^\p{C}]{1,80}$/u),
                v.description('How this client is shown in the owner\'s device list, such as "Codex agent · Linux".'),
            ),
        ),
        /** A browser-held secret naming this redemption, so repeating it after a lost reply returns the same access. */
        redemptionKey: v.optional(
            v.pipe(
                v.string(),
                v.regex(/^[A-Za-z0-9_-]{43}$/u),
                v.description(
                    "32 random bytes, base64url without padding. Persist it before sending; repeating the redemption with the same key after a lost reply returns the same access.",
                ),
            ),
        ),
    }),
    v.readonly(),
);
