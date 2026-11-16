import { createHash } from "node:crypto";
import type { SessionConfigOption } from "@portalcrew/morty-client/protocol";

/**
 * The revision of a Session's configuration, derived from the configuration itself. It covers what a client can act
 * on when it edits a setting: which options exist, their type and category, their current value and the values they
 * offer. Names and descriptions only label those choices and are excluded. Equal configurations therefore have equal
 * revisions in every Agent process, and any change a client could act on yields a different revision.
 *
 * Clients treat the result as an opaque identifier.
 */
export const configurationRevision = (options: readonly SessionConfigOption[]): string => {
    const canonical = options
        .map((option) =>
            JSON.stringify(
                option.type === "boolean"
                    ? [option.id, option.type, option.category, option.booleanValue]
                    : [
                          option.id,
                          option.type,
                          option.category,
                          option.currentValue,
                          option.values.map((value) => value.value).toSorted(),
                      ],
            ),
        )
        .toSorted();
    return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
};
