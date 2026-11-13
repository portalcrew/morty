import type {
    ClientCommand,
    ClientRequest,
    SessionEventsUnsubscribeControl,
    WorkerRequestCancel,
} from "@morty-build/client/protocol";
import type { CommandContext } from "./context.ts";

export type DaemonCommand = ClientCommand | SessionEventsUnsubscribeControl | WorkerRequestCancel;

/** The request of one kind the Relay sends this Computer. */
export type CommandMessage<K extends ClientRequest["kind"]> = Extract<ClientRequest, { readonly kind: K }>;

/** Answers one kind of request the Relay sends this Computer. */
export type CommandHandler<K extends ClientRequest["kind"]> = (
    context: CommandContext,
    message: CommandMessage<K>,
) => void | Promise<void>;
