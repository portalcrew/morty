import { MortyProtocolError } from "../errors.ts";
import type { MortyTransportSessionEvent } from "./ws-transport.ts";

export interface LiveDeliveryExecution {
    readonly run: (operation: (signal: AbortSignal) => Promise<string>) => Promise<string>;
}

// Tokens exist only for deliveries made by the transport, not for arbitrary ciphertext.
const liveDeliveryExecutions = new WeakMap<MortyTransportSessionEvent, LiveDeliveryExecution>();

export function registerLiveDelivery(event: MortyTransportSessionEvent, execution: LiveDeliveryExecution): void {
    liveDeliveryExecutions.set(event, execution);
}

export async function executeLiveDeliveryOnce(
    event: MortyTransportSessionEvent,
    operation: (signal: AbortSignal) => Promise<string>,
    signal: AbortSignal,
): Promise<string> {
    signal.throwIfAborted();
    const execution = liveDeliveryExecutions.get(event);
    if (execution === undefined) {
        throw new MortyProtocolError("The live Session event delivery is invalid");
    }
    return await new Promise<string>((resolve, reject) => {
        const abort = () => {
            signal.removeEventListener("abort", abort);
            reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        execution.run(operation).then(
            (value) => {
                signal.removeEventListener("abort", abort);
                resolve(value);
            },
            (cause: unknown) => {
                signal.removeEventListener("abort", abort);
                reject(cause);
            },
        );
        if (signal.aborted) {
            abort();
        }
    });
}
