import { sameNativeSession } from "@morty-build/client/native-session";
import {
    decodeNativeSessionTarget,
    type NativeSessionTarget,
    ProtocolMessageError,
    type SessionAccessGrant,
    type SessionAccessHolder,
} from "@morty-build/client/protocol";
import { ComputerAuthenticationError } from "../../../../contracts/relay/computer-authentication.ts";
import type { ComputerAccessService } from "../../management/service/computer-access-service.ts";
import { SessionAccessCredentialExpiredError, type SessionAccessSigner } from "../entity/session-access-credential.ts";

export interface SessionAccessTarget {
    readonly computerId: string;
    readonly target: NativeSessionTarget;
}

/** A verified Session credential: the Session it selects, and the authorization of each operation on it. */
export interface SessionAccess {
    readonly signingKeyId: string;
    readonly issuedAtEpochMilliseconds: number;
    /** The holder and pairing generation the credential carries. */
    readonly grant: SessionAccessGrant;
    readonly expiresAtEpochMilliseconds: number;
    readonly computerId: string;
    readonly authorize: (signal: AbortSignal) => Promise<void>;
}

export class SessionAccessService {
    readonly #control: ComputerAccessService;
    readonly #signer: SessionAccessSigner;

    constructor(control: ComputerAccessService, signer: SessionAccessSigner) {
        this.#control = control;
        this.#signer = signer;
    }

    /**
     * Issues a Session credential bound to the active Computer pairing and holder. Ending either
     * authority ends the credential; a later pairing cannot restore it.
     */
    readonly issue = async (
        target: SessionAccessTarget,
        expiresInSeconds: number,
        holder: SessionAccessHolder,
        signal: AbortSignal,
    ): Promise<{
        readonly credential: string;
        readonly expiresAt: string;
        readonly computerId: string;
        readonly target: NativeSessionTarget;
    }> => {
        const nativeTarget = decodeNativeSessionTarget(target.target);
        if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 900) {
            throw new ComputerAuthenticationError("invalid_request", "The Session credential lifetime is invalid");
        }
        await this.#control.authorizeComputer(target.computerId, signal);
        const generation = await this.#control.currentSessionGeneration(target.computerId, holder, signal);
        if (generation === null) {
            throw new ComputerAuthenticationError("credential_revoked", "The Session access has ended");
        }
        const issuedAtEpochMilliseconds = Date.now();
        const expiresAtEpochMilliseconds = issuedAtEpochMilliseconds + expiresInSeconds * 1_000;
        const credential = await this.#signer.issue({
            expiresAtEpochMilliseconds,
            issuedAtEpochMilliseconds,
            computerId: target.computerId,
            purpose: "session-access",
            grant: { holder, generation },
            target: nativeTarget,
        });
        return {
            credential,
            expiresAt: new Date(expiresAtEpochMilliseconds).toISOString(),
            computerId: target.computerId,
            target: nativeTarget,
        };
    };

    readonly authorizeSession = async (
        target: SessionAccessTarget,
        credentialValue: string,
        signal: AbortSignal,
    ): Promise<SessionAccess> => {
        signal.throwIfAborted();
        const access = await this.authenticate(target, credentialValue, signal);
        await access.authorize(signal);
        return access;
    };

    /**
     * Verifies a Session credential for its selected Session without authorizing any operation. Each operation then
     * authorizes the credential's current access before it runs.
     */
    readonly authenticate = async (
        target: SessionAccessTarget,
        credentialValue: string,
        signal: AbortSignal,
    ): Promise<SessionAccess> => {
        let claims: Awaited<ReturnType<SessionAccessSigner["verify"]>>;
        try {
            claims = await this.#signer.verify(credentialValue, Date.now());
        } catch (cause) {
            if (cause instanceof SessionAccessCredentialExpiredError) {
                throw new ComputerAuthenticationError("credential_expired", "The Session credential has expired", {
                    cause,
                });
            }
            if (cause instanceof ProtocolMessageError) {
                throw new ComputerAuthenticationError("credential_invalid", "The Session credential is invalid", {
                    cause,
                });
            }
            throw cause;
        }
        if (claims.computerId !== target.computerId || !sameNativeSession(claims.target, target.target)) {
            throw new ComputerAuthenticationError(
                "session_permission_denied",
                "The credential authorizes only the selected Session",
            );
        }
        signal.throwIfAborted();
        const computerId = target.computerId;
        return {
            signingKeyId: await this.#signer.keyId(),
            issuedAtEpochMilliseconds: claims.issuedAtEpochMilliseconds,
            grant: claims.grant,
            expiresAtEpochMilliseconds: claims.expiresAtEpochMilliseconds,
            computerId: claims.computerId,
            authorize: async (authorizationSignal) => {
                await this.#control.authorizeSession(computerId, claims.grant, authorizationSignal);
            },
        };
    };
}
