import { and, inArray, max, notInArray } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/sqlite-core";
import { computerPairing, computerRegistration, computerRevocation } from "../../../schema/computer-relay-do/index.ts";

const query = new QueryBuilder();

/** The computer's current pairing generation: its latest one. Each computer has its own database. */
export const currentGeneration = () =>
    query.select({ generation: max(computerPairing.generation) }).from(computerPairing);

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
                notInArray(
                    computerRegistration.generation,
                    query.select({ generation: computerRevocation.generation }).from(computerRevocation),
                ),
            ),
        );
