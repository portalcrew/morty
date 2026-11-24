import { linkLifetime, longestDeviceAccessLifetime } from "../../../../contracts/authentication/credential.ts";
import type { SealedHandoffStorage } from "../storage/sealed-handoff-storage.ts";
import type { AuthenticationService } from "./authentication-service.ts";

export type SealedHandoffStaging =
    | { readonly kind: "staged"; readonly expiresAt: number }
    | { readonly kind: "conflict" | "unauthenticated" | "revoked" | "forbidden" };

/**
 * Holds a sealed link's contents while the access the link hands over lasts, so reopening the link later still opens
 * what it named. No access outlasts the longest device term, so neither do the contents.
 */
export class SealedHandoffService {
    readonly #authentication: AuthenticationService;
    readonly #handoffs: SealedHandoffStorage;

    constructor(cx: {
        readonly services: { readonly authentication: AuthenticationService };
        readonly storages: { readonly sealedHandoffs: SealedHandoffStorage };
    }) {
        this.#authentication = cx.services.authentication;
        this.#handoffs = cx.storages.sealedHandoffs;
    }

    readonly stage = async (
        token: string | undefined,
        handoff: { readonly lookupId: string; readonly sealed: string; readonly accessExpiresAt: number },
        signal: AbortSignal,
    ): Promise<SealedHandoffStaging> => {
        const access = await this.#authentication.authorize(token, "shareAccess", signal);
        if (access.kind !== "authorized") {
            return access;
        }
        const now = Date.now();
        const expiresAt = Math.min(
            Math.max(handoff.accessExpiresAt, now + linkLifetime),
            now + longestDeviceAccessLifetime,
        );
        return this.#handoffs.stage({ lookupId: handoff.lookupId, sealed: handoff.sealed, expiresAt }, now, signal);
    };

    readonly read = (lookupId: string, signal: AbortSignal): string | null =>
        this.#handoffs.read(lookupId, Date.now(), signal);
}
