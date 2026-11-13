import {
    MortyOperationError,
    MortyProtocolError,
    type PayloadDecryptor,
    type PayloadEncryptor,
} from "@morty-build/client";
import {
    type ComputerMetadataResource,
    type ComputerMetadataSnapshot,
    computerMetadataRequestCodec,
    computerMetadataResultCodec,
    decodeMessageKind,
    sessionOperationFailedEventCodec,
} from "@morty-build/client/protocol";
import { systemClock } from "../time/clock.ts";
import type { ApiRequest } from "./calls/call.ts";
import { encodeIdentityCall } from "./calls/encode-call.ts";

const paths = { computer: "workspace", computers: "setup/computers", devices: "identity/devices" } as const;

export async function readEncryptedMetadata(
    options: {
        readonly origin: string;
        readonly computerId: string;
        readonly credential: string;
        readonly resource: ComputerMetadataResource;
        readonly encryption: PayloadEncryptor & PayloadDecryptor;
        readonly request: (request: ApiRequest, signal: AbortSignal) => Promise<unknown>;
    },
    parent: AbortSignal,
): Promise<ComputerMetadataSnapshot> {
    const signal = AbortSignal.any([parent, AbortSignal.timeout(30_000)]);
    const requestId = crypto.randomUUID();
    const body = await computerMetadataRequestCodec.encode(
        { kind: "computer.metadata.read", requestId, resource: options.resource, credential: options.credential },
        options.encryption,
        signal,
    );
    const request = encodeIdentityCall({
        origin: options.origin,
        computerId: options.computerId,
        path: paths[options.resource],
        definition: {
            method: "POST",
            operation: `metadata/${options.resource}`,
            timeoutMilliseconds: 30_000,
            watch: "none",
            transport: { kind: "websocket", cancellation: "remote" },
        },
    });
    const encoded = JSON.stringify(await options.request({ ...request, body }, signal));
    if (decodeMessageKind(encoded) === "session.operation.failed") {
        const failure = await sessionOperationFailedEventCodec.decode(encoded, options.encryption, signal);
        if (failure.requestId !== requestId) {
            throw new MortyProtocolError("The Computer returned an invalid metadata response.");
        }
        throw new MortyOperationError(
            failure.code,
            failure.message,
            failure.code === "metadata_access_denied" ? "terminal" : "retryable",
        );
    }
    const reply = await computerMetadataResultCodec.decode(encoded, options.encryption, signal);
    if (reply.requestId !== requestId || reply.result.resource !== options.resource) {
        throw new MortyProtocolError("The Computer returned an invalid metadata response.");
    }
    return reply.result;
}

/** Compare authenticated plaintext snapshots locally; randomized ciphertext is never a watch baseline. */
export async function waitForDecryptedChange<T>(
    options: {
        readonly read: (signal: AbortSignal) => Promise<T>;
        readonly baseline: string | undefined;
        readonly onReady?: (snapshot: T) => void;
    },
    parent: AbortSignal,
): Promise<void> {
    const signal = AbortSignal.any([parent, AbortSignal.timeout(10 * 60 * 1000)]);
    let baseline = options.onReady === undefined ? options.baseline : undefined;
    for (;;) {
        const snapshot = await options.read(signal);
        const value = JSON.stringify(snapshot);
        signal.throwIfAborted();
        if (baseline !== undefined && baseline !== value) {
            return;
        }
        if (baseline === undefined) {
            options.onReady?.(snapshot);
            baseline = value;
        }
        await systemClock.sleep(5000, signal);
    }
}
