import { and, eq, inArray, max, notInArray } from "drizzle-orm";
import { QueryBuilder, type SQLiteColumn } from "drizzle-orm/sqlite-core";
import {
    computerPairing,
    computerRegistration,
    computerRevocation,
    daemonCredential,
} from "../../../schema/computer-relay-do/index.ts";

const query = new QueryBuilder();

export const currentGeneration = () =>
    query.select({ generation: max(computerPairing.generation) }).from(computerPairing);

/** A revocation ends its generation for good: nothing of that generation is open, claimable, or active again. */
export const unrevoked = (generation: SQLiteColumn) =>
    notInArray(generation, query.select({ generation: computerRevocation.generation }).from(computerRevocation));

/**
 * The generation whose daemon may act for the computer: the current one, once a daemon claimed it, until its access
 * ends. Every authorization of a Computer credential or connection reads this one rule.
 */
export const activeGeneration = () =>
    query
        .select({ generation: computerRegistration.generation })
        .from(computerRegistration)
        .where(
            and(
                inArray(computerRegistration.generation, currentGeneration()),
                unrevoked(computerRegistration.generation),
            ),
        );

/** The daemon credential `tokenHash` names, while it acts for the active generation. */
export const activeDaemonCredential = (tokenHash: string) =>
    and(eq(daemonCredential.tokenHash, tokenHash), inArray(daemonCredential.generation, activeGeneration()));
