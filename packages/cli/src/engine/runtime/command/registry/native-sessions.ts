import {
    type SESSION_LIST_KIND,
    SESSION_LISTED_KIND,
    SESSION_QUERIED_KIND,
    type SESSION_QUERY_KIND,
    sessionsListedEventCodec,
    sessionsQueriedEventCodec,
} from "@morty-build/client/protocol";
import type { CommandHandler } from "../definition.ts";
import { reportOperationFailure, send } from "../transport.ts";

export const handleSessionList: CommandHandler<typeof SESSION_LIST_KIND> = (context, message): Promise<void> => {
    const { nativeSessions, signal, socket, payloadEncryption } = context;
    return nativeSessions
        .listSessions(message.limit, signal)
        .then(async (entries) => {
            send(
                socket,
                await sessionsListedEventCodec.encode(
                    { entries, kind: SESSION_LISTED_KIND, requestId: message.requestId },
                    payloadEncryption,
                    signal,
                ),
            );
        })
        .catch(async (error: unknown) => {
            signal.throwIfAborted();
            await reportOperationFailure(context, message.requestId, undefined, error);
        });
};

export const handleSessionQuery: CommandHandler<typeof SESSION_QUERY_KIND> = (context, message): Promise<void> => {
    const { nativeSessions, signal, socket, payloadEncryption } = context;
    return nativeSessions
        .querySessions(message.targets, signal)
        .then(async (entries) => {
            send(
                socket,
                await sessionsQueriedEventCodec.encode(
                    { entries, kind: SESSION_QUERIED_KIND, requestId: message.requestId },
                    payloadEncryption,
                    signal,
                ),
            );
        })
        .catch(async (error: unknown) => {
            signal.throwIfAborted();
            await reportOperationFailure(context, message.requestId, undefined, error);
        });
};
