import { createHash, timingSafeEqual } from "node:crypto";
import { join, resolve } from "node:path";
import {
    type ComputerEncryptionAccess,
    E2EError,
    exportE2EPublicKey,
    PAYLOAD_FUTURE_SKEW_MILLISECONDS,
    PAYLOAD_MAX_AGE_MILLISECONDS,
    type PayloadClaim,
} from "@morty-build/client";
import { type Identifier, isIdentifier } from "@morty-build/client/protocol";
import { z } from "zod";
import { ensurePrivateDirectory } from "../../storage/files/local-files.ts";
import { readInstallationFile, writeInstallationFile } from "../../storage/installation/installation-files.ts";
import { tryLock } from "../../storage/installation/local-lock.ts";
import { validateLocalPath } from "../../util/filesystem/private-path.ts";
import { isNodeError } from "../../util/node-error.ts";

const coordinate = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
// One maximum-size upload already uses 171 encrypted chunks. Keep room for concurrent operations
// while retaining every live claim; the separate file limit below bounds memory and disk use.
const MAX_REPLAY_CLAIMS = 2_048;
const MAX_ENCRYPTION_STATE_BYTES = 256 * 1024;
const privateKeySchema = z
    .object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: coordinate, y: coordinate, d: coordinate })
    .readonly();
const stateSchema = z
    .object({
        version: z.literal(1),
        computerId: z.string().refine(isIdentifier),
        computerE2EPrivateKey: privateKeySchema,
        replayClock: z.number().int().nonnegative().default(0),
        replayClaims: z
            .array(z.object({ fingerprint: coordinate, expiresAt: z.number().int().nonnegative() }).readonly())
            .max(MAX_REPLAY_CLAIMS)
            .default([]),
    })
    .readonly();
type EncryptionState = z.infer<typeof stateSchema>;

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

/** Exactly one persistent encryption identity per Computer; browser connection keys are never stored here. */
export class ComputerEncryptionStore {
    readonly #computerId: Identifier;
    readonly #path: string;
    readonly #lockPath: string;

    private constructor(directory: string, computerId: Identifier) {
        this.#computerId = computerId;
        const name = createHash("sha256").update(computerId).digest("hex");
        this.#path = join(directory, `encryption.${name}.json`);
        this.#lockPath = join(directory, `encryption.${name}.lock.sqlite`);
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
        this.lock(signal, async () => {
            const state = await this.readOrCreate(signal);
            const key = state.computerE2EPrivateKey;
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
                computerE2EAccessSecret: await this.accessSecret(state, signal),
            };
        });

    readonly authorizeAccess = async (secret: string, signal: AbortSignal): Promise<void> =>
        this.lock(signal, async () => {
            const state = await this.readOrCreate(signal);
            const supplied = coordinate.safeParse(secret);
            const expected = await this.accessSecret(state, signal);
            if (
                !supplied.success ||
                !timingSafeEqual(Buffer.from(expected, "base64url"), Buffer.from(supplied.data, "base64url"))
            ) {
                throw new E2EError("e2e_access_denied");
            }
        });

    /** Atomically authorizes and claims a fresh packet before any command may execute. */
    readonly authorizeAndClaim = async (secret: string, claim: PayloadClaim, signal: AbortSignal): Promise<void> =>
        this.lock(signal, async () => {
            const state = await this.readOrCreate(signal);
            const supplied = coordinate.safeParse(secret);
            const expected = await this.accessSecret(state, signal);
            if (
                !supplied.success ||
                !timingSafeEqual(Buffer.from(expected, "base64url"), Buffer.from(supplied.data, "base64url"))
            ) {
                throw new E2EError("e2e_access_denied");
            }
            const now = Math.max(Date.now(), state.replayClock);
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
            const claims = state.replayClaims.filter((prior) => prior.expiresAt > now);
            if (claims.some((prior) => prior.fingerprint === claim.fingerprint) || claims.length >= MAX_REPLAY_CLAIMS) {
                throw new E2EError("e2e_invalid_frame");
            }
            await this.write(
                {
                    ...state,
                    replayClock: now,
                    replayClaims: [...claims, { fingerprint: claim.fingerprint, expiresAt: claim.expiresAt }],
                },
                signal,
            );
        });

    private readonly accessSecret = async (state: EncryptionState, signal: AbortSignal): Promise<string> => {
        // Domain separation derives browser access from the Computer identity without exposing its private key.
        const key = await crypto.subtle.importKey(
            "raw",
            Buffer.from(state.computerE2EPrivateKey.d, "base64url"),
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

    private readonly lock = async <T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> => {
        signal.throwIfAborted();
        try {
            await validateExistingFile(this.#lockPath, signal, false);
            const unlock = tryLock(this.#lockPath);
            if (unlock === null) {
                throw new E2EError("e2e_store_busy");
            }
            try {
                return await operation();
            } finally {
                unlock();
            }
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof E2EError) {
                throw cause;
            }
            throw new E2EError("e2e_store_unavailable", { cause });
        }
    };

    private readonly readOrCreate = async (signal: AbortSignal): Promise<EncryptionState> => {
        await validateExistingFile(this.#path, signal);
        const read = await readInstallationFile(this.#path, MAX_ENCRYPTION_STATE_BYTES);
        signal.throwIfAborted();
        switch (read.kind) {
            case "missing": {
                const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
                    "deriveBits",
                ]);
                const key: unknown = await crypto.subtle.exportKey("jwk", pair.privateKey);
                const state: EncryptionState = {
                    version: 1,
                    computerId: this.#computerId,
                    computerE2EPrivateKey: privateKeySchema.parse(key),
                    replayClock: 0,
                    replayClaims: [],
                };
                await this.write(state, signal);
                return state;
            }
            case "read": {
                const value: unknown = JSON.parse(read.text);
                const state = stateSchema.parse(value);
                if (state.computerId !== this.#computerId) {
                    throw new E2EError("e2e_invalid_access");
                }
                return state;
            }
            case "unopenable":
                throw new E2EError("e2e_store_unavailable", { cause: read.cause });
            case "not-a-small-file":
                throw new E2EError("e2e_store_unavailable");
            default:
                return read satisfies never;
        }
    };

    private readonly write = async (state: EncryptionState, signal: AbortSignal): Promise<void> => {
        await validateExistingFile(this.#path, signal);
        await writeInstallationFile(this.#path, JSON.stringify(stateSchema.parse(state)), signal);
    };
}
