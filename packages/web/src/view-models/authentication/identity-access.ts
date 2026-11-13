import type { ApiTransport } from "../../services/api/api-transport.ts";
import {
    AnonymousIdentityApi,
    IdentityApiError,
    type IdentityTransfer,
    type LinkedDevice,
    type SharingTerms,
} from "../../services/identity/anonymous-identity-api.ts";
import { createRemoteAccessOperations } from "../chat/remote-access-store.ts";

export interface IdentityAccess {
    readonly createTransfer: (terms: SharingTerms, signal: AbortSignal) => Promise<IdentityTransfer>;
    readonly currentAccessToken: (signal: AbortSignal) => Promise<string>;
    /** Ends the access this browser holds when it runs. */
    readonly endRemoteAccess: (signal: AbortSignal) => Promise<void>;
    /** When this browser's access ends, or null when it does not end on its own. */
    readonly accessExpiresAt: (signal: AbortSignal) => Promise<string | null>;
    readonly linkedDevices: (signal: AbortSignal) => Promise<readonly LinkedDevice[]>;
    /** Resolves once the linked devices differ from the list this page last read. */
    readonly waitForLinkedDevicesChange: (signal: AbortSignal) => Promise<void>;
    /** Disconnects every other browser that joined through a link while this one keeps its access. */
    readonly endOtherBrowserAccess: (signal: AbortSignal) => Promise<void>;
    /** Disconnects one other device; this browser and the computer keep their access. */
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
    /** A refusal of this browser's own access is reported to its owner before the caller sees it. */
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
        createTransfer: async (terms, signal) => {
            const localIdentity = await options.currentAccess(signal);
            signal.throwIfAborted();
            if (localIdentity === null || localIdentity.computerId !== options.identity.computerId) {
                throw new IdentitySharingUnavailable();
            }
            return await api.createTransfer(localIdentity.computerToken, terms, signal);
        },
    };
}
