import { MortyApiError } from "@portalcrew/morty-client";
import * as v from "valibot";
import type { ApiTransport } from "../api/api-transport.ts";
import type { ApiRequest } from "../api/calls/call.ts";
import { identityCalls } from "../api/calls/identity.ts";
import { readJsonBody } from "../api/response-body.ts";
import { browserAccessEntry } from "../local-storage/central-local-storage.ts";
import { ManagementApi } from "../management/management-api.ts";
import { centralSessionStorage, transferRedemptionEntry } from "../session-storage/central-session-storage.ts";
import { describeBrowser } from "./device-label.ts";
import {
    type IdentityScope,
    leaveComputerAddress,
    readIdentityScope,
    writeIdentityScope,
} from "./identity-scope-url.ts";
import {
    type StoredAccessWriter,
    storedToken,
    storedTokenForComputer,
    withStoredAccessLock,
} from "./remembered-computers.ts";

const tokenSchema = v.pipe(v.string(), v.regex(/^morty_computer_v1_[A-Za-z0-9_-]{43}$/u));
const computerIdSchema = v.pipe(v.string(), v.regex(/^prj_(wn|ap|an|as)_01_[A-Za-z0-9_-]{24}$/u));
const identityFields = { computerToken: tokenSchema, computerId: computerIdSchema };
const identitySchema = v.pipe(v.object(identityFields), v.readonly());
/**
 * The Computer a well-formed transfer code names, or null when the code cannot
 * name one. A code that was already redeemed in this browser still names its
 * Computer, which is what lets a dead link fall back to the access it issued.
 */
export function transferCodeComputer(code: string): string | null {
    const parts = code.split(".");
    return parts.length === 3 && parts[0] === "morty_transfer_v1" ? (parts[1] ?? null) : null;
}

export const ANONYMOUS_CREDENTIAL_KEY_NAME = browserAccessEntry.key;

const anonymousSessionSchema = v.pipe(v.object({ computerId: computerIdSchema }), v.readonly());
const accessTermSchema = v.object({ accessExpiresAt: v.nullable(v.pipe(v.string(), v.isoTimestamp())) });
export const deviceAccessDurations = ["1h", "1d", "7d", "30d"] as const;
export type DeviceAccessDuration = (typeof deviceAccessDurations)[number];
const transferSchema = v.pipe(
    v.object({
        expiresAt: v.pipe(v.string(), v.isoTimestamp()),
        accessExpiresAt: v.pipe(v.string(), v.isoTimestamp()),
        accessDuration: v.picklist(deviceAccessDurations),
        /** Whether the sharer's own access ends first, and so ends the added device's access earlier than chosen. */
        accessLimitedBySharer: v.boolean(),
        url: v.pipe(v.string(), v.url()),
    }),
    v.readonly(),
);
const deviceSharerSchema = v.variant("kind", [
    v.object({ kind: v.literal("computer") }),
    v.object({ kind: v.literal("device"), label: v.nullable(v.string()) }),
]);
const linkedDeviceSchema = v.pipe(
    v.object({
        id: v.string(),
        joinedAt: v.pipe(v.string(), v.isoTimestamp()),
        label: v.nullable(v.string()),
        location: v.nullable(
            v.object({
                city: v.nullable(v.string()),
                country: v.nullable(v.pipe(v.string(), v.regex(/^[A-Z]{2}$/u))),
            }),
        ),
        accessExpiresAt: v.pipe(v.string(), v.isoTimestamp()),
        addedBy: v.nullable(deviceSharerSchema),
    }),
    v.readonly(),
);
export type LinkedDevice = v.InferOutput<typeof linkedDeviceSchema>;
const linkedDevicesSchema = v.object({ devices: v.array(linkedDeviceSchema) });
const deviceAccessEndedSchema = v.object({ status: v.literal("device_access_ended") });
const otherBrowserAccessEndedSchema = v.object({ status: v.literal("other_browser_access_ended") });
const credentialRevocationPathSchema = v.picklist(["/identity/local-credential", "/identity/browser-access"]);
export type AnonymousIdentity = v.InferOutput<typeof identitySchema>;
export type IdentityTransfer = v.InferOutput<typeof transferSchema>;
export interface SharingTerms {
    /** The same operation is retained until its outcome is known. */
    readonly operationId: string;
    readonly accessDuration: DeviceAccessDuration | null;
    readonly replaces: string | null;
}

export type AccessCheck = { readonly kind: "open"; readonly identity: AnonymousIdentity } | LostAccess;

export type LostAccess = { readonly kind: "revoked" } | { readonly kind: "gone" };

/** The reason the Worker gives, beside UNAUTHENTICATED, for a credential whose access was ended. */
const ACCESS_REVOKED = "ACCESS_REVOKED";

interface Options {
    readonly fetchRequest: ApiTransport["fetch"];
    readonly origin: string;
}

interface IdentityRequest {
    readonly headers: Readonly<Record<string, string>>;
}

/**
 * This tab's key for redeeming `code`. It is kept until the access the redemption returns is saved, so retrying or
 * reloading after a lost reply repeats the same redemption and gets that access back.
 */
function transferRedemptionKey(code: string): string {
    const kept = centralSessionStorage.read(transferRedemptionEntry);
    if (kept?.code === code) {
        return kept.key;
    }
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "");
    centralSessionStorage.write(transferRedemptionEntry, { code, key });
    return key;
}

export class AnonymousIdentityApi {
    readonly #fetchRequest: ApiTransport["fetch"];
    readonly #origin: string;

    constructor(options: Options) {
        this.#fetchRequest = options.fetchRequest;
        this.#origin = v.parse(v.pipe(v.string(), v.url()), options.origin);
    }

    readonly loadScope = async (scope: IdentityScope, signal: AbortSignal): Promise<AnonymousIdentity | null> => {
        const checked = await this.checkScope(scope, signal);
        return checked.kind === "open" ? checked.identity : null;
    };

    /**
     * Validate one access without navigating or changing recency. Access another tab replaced while the check ran,
     * including a replacement still being saved, is checked in turn instead of being forgotten with the access it
     * replaced.
     */
    readonly checkScope = async (scope: IdentityScope, signal: AbortSignal): Promise<AccessCheck> => {
        for (;;) {
            signal.throwIfAborted();
            const token = storedToken(scope.computerId);
            if (token === null) {
                return { kind: "gone" };
            }
            const checked = await this.#checkAccess({ ...scope, computerToken: token }, signal);
            if (checked.kind === "open") {
                return checked;
            }
            // A tab replacing this access holds the lock until it saves the replacement, so forgetting waits for it
            // and checks the replacement instead. Access another check already forgot keeps this check's verdict.
            if (
                await withStoredAccessLock(
                    signal,
                    async (access) => access.forgetRejected(scope, token) || storedToken(scope.computerId) === null,
                )
            ) {
                return checked;
            }
        }
    };

    readonly #checkAccess = async (identity: AnonymousIdentity, signal: AbortSignal): Promise<AccessCheck> => {
        const session = await this.#anonymousSession(identity, signal);
        signal.throwIfAborted();
        if (session === "revoked") {
            return { kind: "revoked" };
        }
        if (session?.computerId !== identity.computerId) {
            return { kind: "gone" };
        }
        const management = new ManagementApi({
            fetchRequest: this.#fetchRequest,
            origin: this.#origin,
            computerId: identity.computerId,
            getToken: async (requestSignal) => {
                requestSignal.throwIfAborted();
                return identity.computerToken;
            },
        });
        try {
            const computer = await management.readComputer(signal);
            signal.throwIfAborted();
            if (computer === null) {
                return { kind: "gone" };
            }
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof MortyApiError && (cause.status === 401 || cause.status === 403)) {
                // The session answered before the computer refused this access: access ended in between is reported
                // as ended, not as a link that does not open the computer.
                const session = await this.#anonymousSession(identity, signal);
                signal.throwIfAborted();
                return session === "revoked" ? { kind: "revoked" } : { kind: "gone" };
            }
            throw cause;
        }
        return { kind: "open", identity };
    };

    readonly createTransfer = async (
        token: string,
        terms: SharingTerms,
        signal: AbortSignal,
    ): Promise<IdentityTransfer> =>
        v.parse(
            transferSchema,
            await this.#request(
                identityCalls.createTransfer({
                    origin: this.#origin,
                    computerId: this.#computerId(),
                    operationId: terms.operationId,
                    accessDuration: terms.accessDuration,
                    replaces: terms.replaces,
                }),
                {
                    headers: {
                        authorization: `Bearer ${v.parse(tokenSchema, token)}`,
                        "content-type": "application/json",
                    },
                },
                signal,
            ),
        );

    /** A setup link's sealed contents, or null once the link expired or never existed. */
    readonly setupHandoff = async (
        computerId: string,
        lookupId: string,
        signal: AbortSignal,
    ): Promise<string | null> => {
        try {
            return v.parse(
                v.object({ sealed: v.string() }),
                await this.#request(
                    identityCalls.setupHandoff({ origin: this.#origin, computerId, lookupId }),
                    { headers: {} },
                    signal,
                ),
            ).sealed;
        } catch (cause) {
            if (cause instanceof IdentityApiError && cause.code === "SETUP_HANDOFF_UNAVAILABLE") {
                return null;
            }
            throw cause;
        }
    };

    readonly redeemTransfer = async (code: string, signal: AbortSignal): Promise<AnonymousIdentity> =>
        await withStoredAccessLock(signal, (access) => this.#redeemTransfer(code, signal, access));

    readonly #redeemTransfer = async (
        code: string,
        signal: AbortSignal,
        access: StoredAccessWriter,
    ): Promise<AnonymousIdentity> => {
        const computerId = transferCodeComputer(code);
        const replaces = computerId === null ? null : storedTokenForComputer(computerId);
        const redemptionKey = transferRedemptionKey(code);
        const identity = v.parse(
            identitySchema,
            await this.#request(
                identityCalls.redeemTransfer({
                    origin: this.#origin,
                    computerId: null,
                    code,
                    replaces,
                    device: describeBrowser(navigator.userAgent),
                    redemptionKey,
                }),
                {
                    headers: { "content-type": "application/json" },
                },
                signal,
            ),
        );
        this.#saveIdentity(identity, access);
        centralSessionStorage.remove(transferRedemptionEntry);
        return identity;
    };

    readonly waitForLinkedDevicesChange = async (
        token: string,
        waitForChange: ApiTransport["waitForChange"],
        signal: AbortSignal,
    ): Promise<void> =>
        await waitForChange({
            ...identityCalls.linkedDevices({ origin: this.#origin, computerId: this.#computerId() }),
            headers: { authorization: `Bearer ${v.parse(tokenSchema, token)}` },
            signal,
        });

    /** When this access ends: the browser's device term, the latest among the links it opened; null without one. */
    readonly accessExpiresAt = async (token: string, signal: AbortSignal): Promise<string | null> =>
        v.parse(
            accessTermSchema,
            await this.#request(
                identityCalls.session({ origin: this.#origin, computerId: this.#computerId() }),
                { headers: { authorization: `Bearer ${v.parse(tokenSchema, token)}` } },
                signal,
            ),
        ).accessExpiresAt;

    readonly linkedDevices = async (token: string, signal: AbortSignal): Promise<readonly LinkedDevice[]> =>
        v.parse(
            linkedDevicesSchema,
            await this.#request(
                identityCalls.linkedDevices({ origin: this.#origin, computerId: this.#computerId() }),
                { headers: { authorization: `Bearer ${v.parse(tokenSchema, token)}` } },
                signal,
            ),
        ).devices;

    /**
     * Ends the access of every other browser that joined through a link, and closes the chat windows open with it;
     * this browser and the computer keep theirs. Repeating it after a failure is safe.
     */
    readonly endOtherBrowserAccess = async (token: string, signal: AbortSignal): Promise<void> => {
        v.parse(
            otherBrowserAccessEndedSchema,
            await this.#request(
                identityCalls.endOtherBrowserAccess({ origin: this.#origin, computerId: this.#computerId() }),
                { headers: { authorization: `Bearer ${v.parse(tokenSchema, token)}` } },
                signal,
            ),
        );
    };

    readonly endDeviceAccess = async (token: string, deviceId: string, signal: AbortSignal): Promise<void> => {
        v.parse(
            deviceAccessEndedSchema,
            await this.#request(
                identityCalls.endDeviceAccess({ origin: this.#origin, computerId: this.#computerId(), deviceId }),
                { headers: { authorization: `Bearer ${v.parse(tokenSchema, token)}` } },
                signal,
            ),
        );
    };

    readonly endRemoteAccess = async (
        token: string,
        signal: AbortSignal,
        access: StoredAccessWriter,
    ): Promise<void> => {
        const headers = { authorization: `Bearer ${v.parse(tokenSchema, token)}` };
        const session = await this.#response(
            identityCalls.session({ origin: this.#origin, computerId: this.#computerId() }),
            { headers },
            signal,
        );
        await session.body?.cancel();
        const path = v.parse(credentialRevocationPathSchema, session.headers.get("Morty-Credential-Revocation"));
        const request =
            path === "/identity/local-credential"
                ? identityCalls.endLocalCredential({ origin: this.#origin, computerId: this.#computerId() })
                : identityCalls.endBrowserAccess({ origin: this.#origin, computerId: this.#computerId() });
        await this.#request(request, { headers }, signal);
        const scope = readIdentityScope();
        if (scope !== null) {
            access.forget(scope);
        }
        leaveComputerAddress();
    };

    readonly #saveIdentity = (identity: AnonymousIdentity, access: StoredAccessWriter) => {
        const scope = { computerId: identity.computerId };
        access.save(scope, identity.computerToken);
        writeIdentityScope(scope);
    };

    readonly #anonymousSession = async (
        identity: AnonymousIdentity,
        requestSignal: AbortSignal,
    ): Promise<v.InferOutput<typeof anonymousSessionSchema> | "revoked" | null> => {
        try {
            return v.parse(
                anonymousSessionSchema,
                await this.#request(
                    identityCalls.session({ origin: this.#origin, computerId: identity.computerId }),
                    {
                        headers: {
                            authorization: `Bearer ${identity.computerToken}`,
                        },
                    },
                    requestSignal,
                ),
            );
        } catch (error) {
            requestSignal.throwIfAborted();
            if (error instanceof IdentityApiError && error.status === 401 && error.reason === ACCESS_REVOKED) {
                return "revoked";
            }
            if (error instanceof IdentityApiError && (error.status === 401 || error.status === 403)) {
                return null;
            }
            throw error;
        }
    };

    readonly #request = async (
        request: ApiRequest,
        init: IdentityRequest,
        requestSignal: AbortSignal,
    ): Promise<unknown> => {
        const response = await this.#response(request, init, requestSignal);
        const value = response.status === 204 ? null : await readJsonBody(response, requestSignal);
        requestSignal.throwIfAborted();
        if (value === undefined) {
            throw new IdentityApiError("IDENTITY_UNAVAILABLE", "Identity service is unavailable.", response.status);
        }
        return value;
    };

    readonly #computerId = (): string => {
        const scope = readIdentityScope();
        if (scope === null) {
            throw new IdentityApiError("COMPUTER_REQUIRED", "Choose a Computer to continue.", 400);
        }
        return scope.computerId;
    };

    readonly #response = async (
        request: ApiRequest,
        init: IdentityRequest,
        requestSignal: AbortSignal,
    ): Promise<Response> => {
        const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(request.endpoint.timeoutMilliseconds)]);
        const response = await this.#fetchRequest({
            ...request,
            headers: init.headers,
            signal,
        });
        signal.throwIfAborted();
        if (!response.ok) {
            const value = await readJsonBody(response, signal);
            signal.throwIfAborted();
            const error = v.safeParse(
                v.object({
                    error: v.object({ code: v.string(), message: v.string(), reason: v.optional(v.string()) }),
                }),
                value,
            );
            throw new IdentityApiError(
                error.success ? error.output.error.code : "IDENTITY_UNAVAILABLE",
                error.success ? error.output.error.message : "Identity service is unavailable.",
                response.status,
                error.success ? (error.output.error.reason ?? null) : null,
            );
        }
        return response;
    };
}

export class IdentityApiError extends Error {
    readonly code: string;
    readonly status: number | null;
    readonly reason: string | null;
    constructor(code: string, message: string, status: number | null = null, reason: string | null = null) {
        super(message);
        this.code = code;
        this.status = status;
        this.reason = reason;
        this.name = "IdentityApiError";
    }
}
