import { MORTY_API_PREFIX } from "@morty-build/client/protocol";
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
    return async (request, subscription, observer) => {
        const path = new URL(request.url).pathname;
        const prefix = `${MORTY_API_PREFIX}/v1/computers/`;
        let parts: string[];
        try {
            parts = path.startsWith(prefix) ? path.slice(prefix.length).split("/").map(decodeURIComponent) : [];
        } catch {
            throw new WebSocketDispatchError();
        }
        const [computer, harnesses, harness, sessions, session, events] = parts;
        if (
            parts.length !== 6 ||
            computer === undefined ||
            harness === undefined ||
            session === undefined ||
            harnesses !== "harnesses" ||
            sessions !== "sessions" ||
            events !== "events" ||
            !ctx.ownsComputer(computer)
        ) {
            throw new WebSocketDispatchError();
        }
        const credential = (request.headers.get("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
        if (credential === undefined) {
            throw new WebSocketDispatchError();
        }
        const computerId = validateIdentifier(computer, "computer_id");
        const target = {
            harness: validateIdentifier(harness, "harness"),
            sessionId: validateIdentifier(session, "session_id"),
        };
        using deadline = new RequestDeadline(request.signal, 30_000);
        const services = ctx.services.forComputer(computerId);
        const access = await services.sessions.authenticate(
            { kind: "session", computerId, target },
            credential,
            deadline.signal,
        );
        await access.authorize(deadline.signal);
        await services.operations.subscribeSessionEvents(
            computerId,
            target,
            subscription,
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
