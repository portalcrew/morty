import { MortyError } from "@morty-build/client";
import {
    COMPUTER_METADATA_CREDENTIAL_HEADER,
    COMPUTER_METADATA_SUCCESSOR_HEADER,
    type ComputerMetadataRequest,
    computerMetadataResultCodec,
    decodeComputerMetadataSnapshot,
    ENCRYPTED_MESSAGE_MAX_PLAINTEXT_BYTES,
    sessionOperationFailedEventCodec,
} from "@morty-build/client/protocol";
import { fetch, type Response } from "undici";
import { environmentProxyDispatcher } from "../../util/network/environment-proxy.ts";
import { relayHttpEndpoint } from "../relay/relay-authentication.ts";
import type { CommandContext } from "./context.ts";
import { send } from "./transport.ts";

async function readSnapshot(response: Response, signal: AbortSignal): Promise<string> {
    if (response.body === null) {
        throw new MortyError("metadata_invalid_response", "Computer metadata is unavailable.");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let encoded = "";
    let complete = false;
    try {
        for (;;) {
            signal.throwIfAborted();
            const chunk = await reader.read();
            if (chunk.done) {
                complete = true;
                return encoded + decoder.decode();
            }
            bytes += chunk.value.byteLength;
            if (bytes > ENCRYPTED_MESSAGE_MAX_PLAINTEXT_BYTES) {
                throw new MortyError("metadata_invalid_response", "Computer metadata is unavailable.");
            }
            encoded += decoder.decode(chunk.value, { stream: true });
        }
    } finally {
        if (!complete) {
            await reader.cancel().catch(() => undefined);
        }
        reader.releaseLock();
    }
}

/** The Computer, never the Worker, owns encryption of the response to an authenticated read. */
export function createComputerMetadataReads(context: CommandContext) {
    const pending = new Map<string, { readonly cancellation: AbortController; readonly settled: Promise<void> }>();
    const read = async (message: ComputerMetadataRequest, signal: AbortSignal): Promise<void> => {
        const endpoint = relayHttpEndpoint(context.config.relayUrl);
        endpoint.pathname = `/morty/api/v1/computers/${encodeURIComponent(context.config.computerId)}/metadata/snapshot`;
        const sendRequest = async () => {
            const credentials = await context.config.credentials.held(signal);
            const response = await fetch(endpoint, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${message.credential}`,
                    "content-type": "application/json",
                    [COMPUTER_METADATA_CREDENTIAL_HEADER]: credentials.current,
                    ...(credentials.successor === null
                        ? {}
                        : { [COMPUTER_METADATA_SUCCESSOR_HEADER]: credentials.successor }),
                },
                body: JSON.stringify({ resource: message.resource }),
                dispatcher: environmentProxyDispatcher,
                signal,
                redirect: "error",
            });
            return { response, credentials };
        };
        let attempt = await sendRequest();
        if (attempt.response.status === 401) {
            const held = await context.config.credentials.held(signal);
            if (held.current !== attempt.credentials.current || held.successor !== attempt.credentials.successor) {
                await attempt.response.body?.cancel();
                attempt = await sendRequest();
            }
        }
        const response = attempt.response;
        if (!response.ok) {
            await response.body?.cancel();
            throw new MortyError(
                response.status === 401 || response.status === 403 ? "metadata_access_denied" : "metadata_unavailable",
                "Computer metadata is unavailable.",
            );
        }
        const result = decodeComputerMetadataSnapshot(await readSnapshot(response, signal));
        if (result.resource !== message.resource) {
            throw new MortyError("metadata_invalid_response", "Computer metadata is unavailable.");
        }
        signal.throwIfAborted();
        send(
            context.socket,
            await computerMetadataResultCodec.encode(
                { kind: "computer.metadata.result", requestId: message.requestId, result },
                context.payloadEncryption,
                signal,
            ),
        );
    };
    return {
        handle: (message: ComputerMetadataRequest): Promise<void> => {
            if (pending.has(message.requestId) || pending.size >= 16) {
                return sessionOperationFailedEventCodec
                    .encode(
                        {
                            kind: "session.operation.failed",
                            requestId: message.requestId,
                            code: "metadata_busy",
                            message: "Computer metadata is unavailable.",
                        },
                        context.payloadEncryption,
                        context.signal,
                    )
                    .then((encoded) => send(context.socket, encoded));
            }
            const cancellation = new AbortController();
            const timeout = AbortSignal.timeout(20_000);
            const signal = AbortSignal.any([context.signal, cancellation.signal, timeout]);
            const settled = read(message, signal)
                .catch(async (cause: unknown) => {
                    context.signal.throwIfAborted();
                    if (cancellation.signal.aborted) {
                        throw cancellation.signal.reason;
                    }
                    send(
                        context.socket,
                        await sessionOperationFailedEventCodec.encode(
                            {
                                kind: "session.operation.failed",
                                requestId: message.requestId,
                                code: timeout.aborted
                                    ? "metadata_timeout"
                                    : cause instanceof MortyError
                                      ? cause.code
                                      : "metadata_unavailable",
                                message: "Computer metadata is unavailable.",
                            },
                            context.payloadEncryption,
                            context.signal,
                        ),
                    );
                })
                .finally(() => pending.delete(message.requestId));
            pending.set(message.requestId, { cancellation, settled });
            return settled;
        },
        cancel: (requestId: string): void =>
            pending.get(requestId)?.cancellation.abort(new DOMException("Metadata read cancelled", "AbortError")),
        settle: async (): Promise<void> => {
            await Promise.allSettled(Array.from(pending.values(), ({ settled }) => settled));
        },
    };
}
