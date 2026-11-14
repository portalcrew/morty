import { validateIdentifier } from "../../../../contracts/relay/pairing.ts";
import type { SubscribeSessionEvents } from "../../../../contracts/session-event-subscription.ts";
import { WebSocketDispatchError } from "../../../../contracts/websocket-http-dispatch.ts";
import { RequestDeadline } from "../../../../http/request-deadline.ts";
import type { SessionWebSocketServices } from "./session-websocket-routes.ts";

export function createSessionEventSubscriptions(ctx: {
    readonly ownsComputer: (computerId: string) => boolean;
    readonly services: { readonly forComputer: (computerId: string) => SessionWebSocketServices };
    readonly connectionOpened: () => Promise<void>;
}): SubscribeSessionEvents {
    return async (request, observer) => {
        if (!ctx.ownsComputer(request.computerId)) {
            throw new WebSocketDispatchError();
        }
        const computerId = validateIdentifier(request.computerId, "computer_id");
        const target = {
            harness: validateIdentifier(request.harness, "harness"),
            sessionId: validateIdentifier(request.sessionId, "session_id"),
        };
        using deadline = new RequestDeadline(request.signal, 30_000);
        const services = ctx.services.forComputer(computerId);
        const access = await services.sessions.authenticate(
            { computerId, target },
            request.credential,
            deadline.signal,
        );
        await access.authorize(deadline.signal);
        await services.operations.subscribeSessionEvents(
            computerId,
            target,
            request.command,
            {
                signingKeyId: access.signingKeyId,
                grant: access.grant,
                expiresAt: access.expiresAtEpochMilliseconds,
            },
            observer,
            deadline.signal,
        );
        await ctx.connectionOpened();
        deadline.signal.throwIfAborted();
    };
}
