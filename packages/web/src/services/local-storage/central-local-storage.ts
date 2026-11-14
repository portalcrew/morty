import { isDirectoryPath, isIdentifier, MAX_WORKSPACE_PATH_LENGTH } from "@morty-build/client/protocol";
import * as v from "valibot";
import { identityScopeSchema } from "../identity/identity-scope-url.ts";
import { jsonStorageEntry, type StorageEntry, scopedKey, stringStorageEntry } from "../storage-entry.ts";

/**
 * Central management of every value the web application persists in browser
 * local storage. Business modules never touch `window.localStorage` directly;
 * they read and write through `centralLocalStorage` with an entry registered
 * here. Each entry owns its stored key name, its value schema, and its
 * encode/decode contract:
 *
 * - `decode` returns `null` for anything it cannot represent; callers treat
 *   that value as absent.
 * - `encode` failure skips the write entirely.
 */

export const centralLocalStorage = {
    /** Reads and decodes; null when absent, undecodable, or storage is unavailable. */
    read: <T>(entry: StorageEntry<T>): T | null => {
        let raw: string | null;
        try {
            raw = window.localStorage.getItem(entry.key);
        } catch {
            return null;
        }
        return raw === null ? null : entry.decode(raw);
    },
    /** Removes the stored value. */
    remove: (entry: StorageEntry<never> | { readonly key: string }): void => {
        try {
            window.localStorage.removeItem(entry.key);
        } catch {}
    },
    /** Encodes and stores; a failed encode or unavailable storage skips the write. */
    write: <T>(entry: StorageEntry<T>, value: T): boolean => {
        try {
            window.localStorage.setItem(entry.key, entry.encode(value));
            return true;
        } catch {
            return false;
        }
    },
};

const settingIdentifierSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128));

export const computerEncryptionEntry = (computerId: string) =>
    jsonStorageEntry({
        key: scopedKey("morty:computer-encryption:v1:", computerId),
        schema: v.pipe(
            v.strictObject({
                computerId: v.pipe(
                    v.string(),
                    v.check((value) => isIdentifier(value)),
                ),
                computerE2EPublicKey: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{87}$/u)),
                computerE2EAccessSecret: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/u)),
            }),
            v.readonly(),
        ),
    });

// ---------------------------------------------------------------------------
// Chosen agent settings per Bot and agent
// ---------------------------------------------------------------------------

/** A choice the user made for one setting, in the shape the protocol states one. */
const agentSettingPreferenceSchema = v.variant("type", [
    v.object({ booleanValue: v.boolean(), configId: settingIdentifierSchema, type: v.literal("boolean") }),
    v.object({
        configId: settingIdentifierSchema,
        type: v.literal("select"),
        value: v.pipe(v.string(), v.maxLength(500)),
    }),
]);

export const MAX_AGENT_SETTING_PREFERENCES = 100;

/**
 * The settings the user chose for an Agent, one per setting. Version 1 stored every setting a Session ran with,
 * chosen or not; those entries cannot tell a choice from a default, so they are no longer read. Version 2 stated a
 * choice as a kind and a value; it is no longer read either.
 */
export const lastAgentSettingsEntry = (computerId: string, harness: string) =>
    jsonStorageEntry({
        key: scopedKey("morty:last-agent-settings:v3:", computerId, harness),
        schema: v.pipe(
            v.array(agentSettingPreferenceSchema),
            v.maxLength(MAX_AGENT_SETTING_PREFERENCES),
            v.check(
                (preferences) =>
                    new Set(preferences.map((preference) => preference.configId)).size === preferences.length,
                "Duplicate setting identifiers",
            ),
            v.readonly(),
        ),
    });

// ---------------------------------------------------------------------------
// Last harness per Bot
// ---------------------------------------------------------------------------

/**
 * The harness a computer last worked in, so a new draft continues there instead of
 * falling back to whichever connected Agent happens to be listed first.
 */
export const lastHarnessEntry = (computerId: string): StorageEntry<string> =>
    stringStorageEntry({
        key: scopedKey("morty:last-harness:v1:", computerId),
        schema: settingIdentifierSchema,
    });

// ---------------------------------------------------------------------------
// Working-directory preferences
// ---------------------------------------------------------------------------

const directorySchema = v.custom<string>(isDirectoryPath, "Invalid directory path");
const directoryLabelSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_WORKSPACE_PATH_LENGTH));

export const lastCwdEntry = (computerId: string, harness: string): StorageEntry<string> =>
    stringStorageEntry({
        key: scopedKey("morty:last-cwd:", computerId, harness),
        schema: directorySchema,
    });

const recentCwdPreferenceSchema = v.pipe(
    v.object({ directory: directorySchema, directoryLabel: directoryLabelSchema }),
    v.readonly(),
);
export type RecentCwdPreference = v.InferOutput<typeof recentCwdPreferenceSchema>;

export const recentCwdEntry = (computerId: string) =>
    jsonStorageEntry({
        key: scopedKey("morty:recent-cwd:", computerId),
        schema: v.pipe(
            v.array(recentCwdPreferenceSchema),
            v.maxLength(10),
            v.check(
                (recent) => new Set(recent.map((preference) => preference.directory)).size === recent.length,
                "Duplicate recent directories",
            ),
            v.readonly(),
        ),
    });

// ---------------------------------------------------------------------------
// Computer access tokens
// ---------------------------------------------------------------------------

const computerTokenSchema = v.pipe(v.string(), v.regex(/^morty_computer_v1_[A-Za-z0-9_-]{43}$/u));

/** How many computers and their access tokens this browser remembers. */
export const MAX_REMEMBERED_COMPUTERS = 10;

const credentialComputerIdSchema = v.pipe(v.string(), v.regex(/^prj_(wn|ap|an|as)_01_[A-Za-z0-9_-]{24}$/u));

/** Access membership and credentials commit together; presentation never writes this entry. */
export const browserAccessEntry = jsonStorageEntry({
    key: "morty:browser-access:v2",
    schema: v.pipe(
        v.object({
            credentials: v.record(v.string(), v.unknown()),
            computers: v.array(v.unknown()),
        }),
        v.readonly(),
    ),
});

/** A stored token this version can use, or null. */
export function readableCredential(computerId: string, token: unknown): string | null {
    return v.is(credentialComputerIdSchema, computerId) && v.is(computerTokenSchema, token) ? token : null;
}

const computerDestinationSchema = v.pipe(
    v.variant("kind", [
        v.object({ kind: v.literal("home") }),
        v.object({
            kind: v.literal("session"),
            harness: v.custom<string>(isIdentifier),
            sessionId: v.custom<string>(isIdentifier),
        }),
    ]),
    v.readonly(),
);

const computerPreferenceSchema = v.pipe(
    v.object({
        destination: computerDestinationSchema,
        name: v.pipe(v.string(), v.maxLength(256)),
        directory: v.nullable(v.pipe(v.string(), v.maxLength(4096))),
        lastUsedAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    }),
    v.readonly(),
);

export type ComputerDestination = v.InferOutput<typeof computerDestinationSchema>;
export type RememberedComputer = v.InferOutput<typeof computerPreferenceSchema> & {
    readonly scope: v.InferOutput<typeof identityScopeSchema>;
};

/** Preferences have no authority to add, replace or remove access. Each computer writes only its own preferences. */
export const computerPreferenceEntry = (scope: { readonly computerId: string }) =>
    jsonStorageEntry({
        key: scopedKey("morty:computer-preference:v2:", scope.computerId),
        schema: computerPreferenceSchema,
    });

/** An access record names only its scope. Everything displayed about it is a preference. */
export function readableComputer(value: unknown): RememberedComputer | null {
    const parsed = v.safeParse(v.object({ scope: identityScopeSchema }), value);
    if (!parsed.success) {
        return null;
    }
    return {
        scope: parsed.output.scope,
        destination: { kind: "home" },
        name: "",
        directory: null,
        lastUsedAt: 0,
    };
}

// ---------------------------------------------------------------------------
// Linked devices this browser has been told about
// ---------------------------------------------------------------------------

/** When the latest device this browser was told about joined the Computer; later joins are new to it. */
export const linkedDevicesSeenEntry = (computerId: string): StorageEntry<string> =>
    stringStorageEntry({
        key: scopedKey("morty:linked-devices-seen:v1:", computerId),
        schema: v.pipe(v.string(), v.isoTimestamp()),
    });

/**
 * How far this browser was told about the access that ends at `expiresAt`: that it joined and until when, or also
 * that the access ends soon, which covers the first.
 */
export interface AccessAcknowledgement {
    readonly expiresAt: string;
    readonly through: "joined" | "ending";
}

/** What the user was already told about this browser's access, so it is not repeated for the same access. */
export const accessAcknowledgedEntry = (computerId: string): StorageEntry<AccessAcknowledgement> =>
    jsonStorageEntry({
        key: scopedKey("morty:access-acknowledged:v1:", computerId),
        schema: v.object({
            expiresAt: v.pipe(v.string(), v.isoTimestamp()),
            through: v.picklist(["joined", "ending"]),
        }),
    });
