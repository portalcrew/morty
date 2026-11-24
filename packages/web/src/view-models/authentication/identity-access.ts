import type { ApiTransport } from "../../services/api/api-transport.ts";
import {
    type AccessDurationOptions,
    AnonymousIdentityApi,
    IdentityApiError,
    type LinkedDevice,
    type SharingTerms,
} from "../../services/identity/anonymous-identity-api.ts";
import { type SharedAccess, sharedAccess } from "../../services/identity/shared-access.ts";
import { createRemoteAccessOperations } from "../chat/remote-access-store.ts";

export interface IdentityAccess {
    readonly shareAccess: (terms: SharingTerms, signal: AbortSignal) => Promise<SharedAccess>;
    readonly sharingTerms: (signal: AbortSignal) => Promise<AccessDurationOptions>;
    readonly currentAccessToken: (signal: AbortSignal) => Promise<string>;
    readonly endRemoteAccess: (signal: AbortSignal) => Promise<void>;
    readonly accessExpiresAt: (signal: AbortSignal) => Promise<string | null>;
    readonly linkedDevices: (signal: AbortSignal) => Promise<readonly LinkedDevice[]>;
    readonly waitForLinkedDevicesChange: (signal: AbortSignal) => Promise<void>;
    readonly endOtherBrowserAccess: (signal: AbortSignal) => Promise<void>;
    readonly endDeviceAccess: (deviceId: string, signal: AbortSignal) => Promise<void>;
}

class IdentitySharingUnavailable extends Error {
    readonly code = "identity_sharing_unavailable";

    constructor() {
        super("Morty cannot be shared from this device.");
        this.name = "IdentitySharingUnavailable";
    }
}

export function createIdentityAccess(options: {
    readonly fetchRequest: ApiTransport["fetch"];
    readonly waitForChange: ApiTransport["waitForChange"];
    readonly origin: string;
    readonly identity: { readonly computerId: string; readonly getToken: (signal: AbortSignal) => Promise<string> };
    readonly onAccessEnded: () => void;
    readonly currentAccess: (
        signal: AbortSignal,
    ) => Promise<{ readonly computerId: string; readonly computerToken: string } | null>;
    readonly credentialRejected: () => Promise<void>;
}): IdentityAccess {
    const api = new AnonymousIdentityApi({ fetchRequest: options.fetchRequest, origin: options.origin });
    const remoteAccess = createRemoteAccessOperations({ ...options, onEnded: options.onAccessEnded });
    const withCurrentAccess = async <T>(signal: AbortSignal, operation: (token: string) => Promise<T>): Promise<T> => {
        try {
            return await operation(await remoteAccess.currentAccessToken(signal));
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof IdentityApiError && cause.status === 401) {
                await options.credentialRejected();
            }
            throw cause;
        }
    };
    const sharingToken = async (signal: AbortSignal): Promise<string> => {
        const localIdentity = await options.currentAccess(signal);
        signal.throwIfAborted();
        if (localIdentity === null || localIdentity.computerId !== options.identity.computerId) {
            throw new IdentitySharingUnavailable();
        }
        return localIdentity.computerToken;
    };
    return {
        ...remoteAccess,
        accessExpiresAt: (signal) => withCurrentAccess(signal, (token) => api.accessExpiresAt(token, signal)),
        linkedDevices: (signal) => withCurrentAccess(signal, (token) => api.linkedDevices(token, signal)),
        waitForLinkedDevicesChange: async (signal) =>
            await api.waitForLinkedDevicesChange(
                await remoteAccess.currentAccessToken(signal),
                options.waitForChange,
                signal,
            ),
        endOtherBrowserAccess: (signal) =>
            withCurrentAccess(signal, (token) => api.endOtherBrowserAccess(token, signal)),
        endDeviceAccess: (deviceId, signal) =>
            withCurrentAccess(signal, (token) => api.endDeviceAccess(token, deviceId, signal)),
        shareAccess: async (terms, signal) => {
            const token = await sharingToken(signal);
            return await sharedAccess(
                await api.createTransfer(token, terms, signal),
                (computerId, handoff, stageSignal) => api.stageSealedHandoff(token, computerId, handoff, stageSignal),
                signal,
            );
        },
        sharingTerms: async (signal) => await api.sharingTerms(await sharingToken(signal), signal),
    };
}
