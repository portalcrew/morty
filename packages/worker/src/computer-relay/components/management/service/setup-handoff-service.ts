import { linkLifetime } from "../../../../contracts/authentication/credential.ts";
import type { SetupHandoffStorage } from "../storage/setup-handoff-storage.ts";
import type { AuthenticationService } from "./authentication-service.ts";

export type SetupHandoffStaging =
    | { readonly kind: "staged"; readonly expiresAt: number }
    | { readonly kind: "conflict" | "unauthenticated" | "revoked" | "forbidden" };

/** Holds a setup link's sealed contents for as long as the link it was issued with can add a device. */
export class SetupHandoffService {
    readonly #authentication: AuthenticationService;
    readonly #handoffs: SetupHandoffStorage;

    constructor(cx: {
        readonly services: { readonly authentication: AuthenticationService };
        readonly storages: { readonly setupHandoffs: SetupHandoffStorage };
    }) {
        this.#authentication = cx.services.authentication;
        this.#handoffs = cx.storages.setupHandoffs;
    }

    readonly stage = async (
        token: string | undefined,
        handoff: { readonly lookupId: string; readonly sealed: string },
        signal: AbortSignal,
    ): Promise<SetupHandoffStaging> => {
        const access = await this.#authentication.authorize(token, "stageSetupHandoff", signal);
        if (access.kind !== "authorized") {
            return access;
        }
        const now = Date.now();
        return this.#handoffs.stage({ ...handoff, expiresAt: now + linkLifetime }, now, signal);
    };

    readonly read = (lookupId: string, signal: AbortSignal): string | null =>
        this.#handoffs.read(lookupId, Date.now(), signal);
}
