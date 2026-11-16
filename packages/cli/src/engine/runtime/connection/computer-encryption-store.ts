import { createHash, timingSafeEqual } from "node:crypto";
import { join, resolve } from "node:path";
import {
    type ComputerEncryptionAccess,
    E2EError,
    exportE2EPublicKey,
    PAYLOAD_FUTURE_SKEW_MILLISECONDS,
    PAYLOAD_MAX_AGE_MILLISECONDS,
    type PayloadClaim,
} from "@portalcrew/morty-client";
import { type Identifier, isIdentifier } from "@portalcrew/morty-client/protocol";
import { z } from "zod";
import { ReplayLedgerTable } from "../../storage/encryption/replay-ledger-table.ts";
import { ensurePrivateDirectory } from "../../storage/files/local-files.ts";
import { createInstallationFile, readInstallationFile } from "../../storage/installation/installation-files.ts";
import { openComputerReplayLedgerDatabase } from "../../storage/sqlite/local-databases.ts";
import { validateLocalPath } from "../../util/filesystem/private-path.ts";
import { isNodeError } from "../../util/node-error.ts";

const coordinate = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
// Match the client replay window's 65,536-packet admission bound. This permits hundreds of
// maximum-size uploads per window while retaining every live claim; state remains disk-bounded.
const MAX_REPLAY_CLAIMS = 65_536;
// An identity file written before the replay ledger had its own store also carries that Morty's claims, which are
// ignored; the bound admits such a file so the Computer keeps its identity.
const MAX_IDENTITY_FILE_BYTES = 8 * 1024 * 1024;
const SQLITE_BUSY = 5;
const privateKeySchema = z
    .object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: coordinate, y: coordinate, d: coordinate })
    .readonly();
const identitySchema = z
    .object({
        version: z.literal(1),
        computerId: z.string().refine(isIdentifier),
        computerE2EPrivateKey: privateKeySchema,
    })
    .readonly();
type EncryptionIdentity = z.infer<typeof identitySchema>;

async function validateExistingFile(path: string, signal: AbortSignal, privateAccess = true): Promise<void> {
    try {
        await validateLocalPath(path, false, privateAccess, signal);
    } catch (cause) {
        signal.throwIfAborted();
        if (!isNodeError(cause, "ENOENT")) {
            throw cause;
        }
    }
}

/**
 * Admits a fresh packet once. The ledger's latest admission keeps a clock set back from reopening expired packets, so a
 * packet is judged by the later of the wall clock and the last time a packet was admitted.
 */
function admit(ledger: ReplayLedgerTable, claim: PayloadClaim, wallClock: number): void {
    const now = Math.max(wallClock, ledger.latestAdmission());
    if (
        !coordinate.safeParse(claim.fingerprint).success ||
        !Number.isSafeInteger(claim.issuedAt) ||
        claim.issuedAt < 0 ||
        claim.expiresAt !== claim.issuedAt + PAYLOAD_MAX_AGE_MILLISECONDS ||
        claim.issuedAt > now + PAYLOAD_FUTURE_SKEW_MILLISECONDS ||
        claim.expiresAt <= now
    ) {
        throw new E2EError("e2e_invalid_frame");
    }
    ledger.forgetExpired(now);
    if (ledger.holds(claim.fingerprint)) {
        throw new E2EError("e2e_invalid_frame");
    }
    if (ledger.size() >= MAX_REPLAY_CLAIMS) {
        throw new E2EError("e2e_store_busy");
    }
    ledger.admit(claim.fingerprint, claim.expiresAt, now);
}

function isSqliteBusy(cause: unknown): boolean {
    return cause instanceof Error && "errcode" in cause && cause.errcode === SQLITE_BUSY;
}

/**
 * Exactly one persistent encryption identity per Computer, written once when it is created, and the ledger of the
 * packets it admitted, which changes with every packet. Browser connection keys are never stored here.
 */
export class ComputerEncryptionStore {
    readonly #computerId: Identifier;
    readonly #identityPath: string;
    readonly #ledgerPath: string;

    private constructor(directory: string, computerId: Identifier) {
        this.#computerId = computerId;
        const name = createHash("sha256").update(computerId).digest("hex");
        this.#identityPath = join(directory, `encryption.${name}.json`);
        this.#ledgerPath = join(directory, `encryption.${name}.replay.sqlite`);
    }

    static readonly open = async (
        directory: string,
        computerId: string,
        signal: AbortSignal,
    ): Promise<ComputerEncryptionStore> => {
        if (!isIdentifier(computerId)) {
            throw new E2EError("e2e_invalid_access");
        }
        signal.throwIfAborted();
        const canonical = resolve(directory);
        try {
            await ensurePrivateDirectory(canonical);
            await validateLocalPath(canonical, true, true, signal);
            return new ComputerEncryptionStore(canonical, computerId);
        } catch (cause) {
            signal.throwIfAborted();
            throw new E2EError("e2e_store_unavailable", { cause });
        }
    };

    readonly access = async (signal: AbortSignal): Promise<ComputerEncryptionAccess> =>
        this.guard(signal, async () => {
            const identity = await this.identity(signal);
            const key = identity.computerE2EPrivateKey;
            const publicKey = await crypto.subtle.importKey(
                "jwk",
                { kty: key.kty, crv: key.crv, x: key.x, y: key.y },
                { name: "ECDH", namedCurve: "P-256" },
                true,
                [],
            );
            return {
                computerId: this.#computerId,
                computerE2EPublicKey: await exportE2EPublicKey(publicKey),
                computerE2EAccessSecret: await this.accessSecret(identity, signal),
            };
        });

    /** Atomically authorizes and claims a fresh packet before any command may execute. */
    readonly authorizeAndClaim = async (secret: string, claim: PayloadClaim, signal: AbortSignal): Promise<void> =>
        this.guard(signal, async () => {
            const identity = await this.identity(signal);
            const supplied = coordinate.safeParse(secret);
            const expected = await this.accessSecret(identity, signal);
            if (
                !supplied.success ||
                !timingSafeEqual(Buffer.from(expected, "base64url"), Buffer.from(supplied.data, "base64url"))
            ) {
                throw new E2EError("e2e_access_denied");
            }
            await validateExistingFile(this.#ledgerPath, signal, false);
            signal.throwIfAborted();
            // The ledger's write transaction admits one packet at a time across every process of this Computer.
            const ledger = new ReplayLedgerTable(openComputerReplayLedgerDatabase(this.#ledgerPath));
            try {
                ledger.transaction(() => admit(ledger, claim, Date.now()));
            } finally {
                ledger.close();
            }
        });

    private readonly accessSecret = async (identity: EncryptionIdentity, signal: AbortSignal): Promise<string> => {
        // Domain separation derives browser access from the Computer identity without exposing its private key.
        const key = await crypto.subtle.importKey(
            "raw",
            Buffer.from(identity.computerE2EPrivateKey.d, "base64url"),
            "HKDF",
            false,
            ["deriveBits"],
        );
        const bytes = await crypto.subtle.deriveBits(
            {
                name: "HKDF",
                hash: "SHA-256",
                salt: new TextEncoder().encode(this.#computerId),
                info: new TextEncoder().encode("morty.e2e.computer-access.v1"),
            },
            key,
            256,
        );
        signal.throwIfAborted();
        return Buffer.from(bytes).toString("base64url");
    };

    private readonly guard = async <T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> => {
        signal.throwIfAborted();
        try {
            return await operation();
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof E2EError) {
                throw cause;
            }
            if (isSqliteBusy(cause)) {
                throw new E2EError("e2e_store_busy", { cause });
            }
            throw new E2EError("e2e_store_unavailable", { cause });
        }
    };

    private readonly identity = async (signal: AbortSignal): Promise<EncryptionIdentity> => {
        const existing = await this.readIdentity(signal);
        if (existing !== null) {
            return existing;
        }
        const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
        const key: unknown = await crypto.subtle.exportKey("jwk", pair.privateKey);
        const created: EncryptionIdentity = {
            version: 1,
            computerId: this.#computerId,
            computerE2EPrivateKey: privateKeySchema.parse(key),
        };
        signal.throwIfAborted();
        try {
            await createInstallationFile(this.#identityPath, JSON.stringify(created));
            return created;
        } catch (cause) {
            if (!isNodeError(cause, "EEXIST")) {
                throw cause;
            }
        }
        const published = await this.readIdentity(signal);
        if (published === null) {
            throw new E2EError("e2e_store_unavailable");
        }
        return published;
    };

    private readonly readIdentity = async (signal: AbortSignal): Promise<EncryptionIdentity | null> => {
        await validateExistingFile(this.#identityPath, signal);
        const read = await readInstallationFile(this.#identityPath, MAX_IDENTITY_FILE_BYTES);
        signal.throwIfAborted();
        switch (read.kind) {
            case "missing":
                return null;
            case "read": {
                const value: unknown = JSON.parse(read.text);
                const identity = identitySchema.parse(value);
                if (identity.computerId !== this.#computerId) {
                    throw new E2EError("e2e_invalid_access");
                }
                return identity;
            }
            case "unopenable":
                throw new E2EError("e2e_store_unavailable", { cause: read.cause });
            case "not-a-small-file":
                throw new E2EError("e2e_store_unavailable");
            default:
                return read satisfies never;
        }
    };
}
