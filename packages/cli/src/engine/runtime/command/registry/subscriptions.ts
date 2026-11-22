import type {
    NativeSessionTarget,
    SessionEventsSubscribeCommand,
    SessionEventsUnsubscribeControl,
} from "@portalcrew/morty-client/protocol";

export function createSessionSubscriptions(subscribed: (target: NativeSessionTarget) => void) {
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
            subscribed(message.target);
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
