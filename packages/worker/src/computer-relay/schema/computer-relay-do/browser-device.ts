import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * A browser that joined the user's computer through a link, described by that first joining. The device owns its
 * access: it holds access until its term unless it was ended first. A browser that opens another link gets a new
 * credential and stays the same device while that device still holds access.
 */
export const browserDevice = sqliteTable("browser_device", {
    id: text("id").primaryKey().notNull(),
    joinedAt: integer("joined_at").notNull(),
    /** How the browser described itself when it joined, so its owner can recognize it; null when it did not. */
    label: text("label"),
    /**
     * Roughly where it joined from, as Cloudflare located the connection: a city and an ISO country code, each null
     * when unknown. The address itself is never kept.
     */
    joinedCity: text("joined_city"),
    joinedCountry: text("joined_country"),
    joinedThroughTransferId: text("joined_through_transfer_id").notNull(),
    /** When the device's access was ended; null while it was not. Ended access never resumes. */
    endedAt: integer("ended_at"),
});
