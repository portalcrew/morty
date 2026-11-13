import type {
    NativeSessionTarget,
    SessionEventsSubscribeCommand,
    SessionEventsUnsubscribeControl,
} from "@morty-build/client/protocol";

/** Tracks the relay's current Session viewers for this Computer connection. */
export function createSessionSubscriptions(changed: () => void) {
    const subscriptions = new Map<string, NativeSessionTarget>();
    return {
        subscribe: (message: SessionEventsSubscribeCommand): void => {
            const current = subscriptions.get(message.subscriptionId);
            if (
                current !== undefined &&
                (current.harness !== message.target.harness || current.sessionId !== message.target.sessionId)
            ) {
                throw new Error("Subscription address conflict");
            }
            subscriptions.set(message.subscriptionId, message.target);
            changed();
        },
        unsubscribe: (message: SessionEventsUnsubscribeControl): void => {
            const current = subscriptions.get(message.subscriptionId);
            if (current?.harness === message.target.harness && current.sessionId === message.target.sessionId) {
                subscriptions.delete(message.subscriptionId);
            }
        },
        isSubscribed: (target: NativeSessionTarget): boolean =>
            [...subscriptions.values()].some(
                (current) => current.harness === target.harness && current.sessionId === target.sessionId,
            ),
        close: (): void => subscriptions.clear(),
    };
}
