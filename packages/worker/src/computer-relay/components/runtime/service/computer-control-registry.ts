import {
    type ClientToRelayMessage,
    daemonToRelayDecoders,
    type NativeSessionTarget,
} from "@portalcrew/morty-client/protocol";

export type ClientControlCommand = Exclude<
    ClientToRelayMessage,
    {
        readonly kind:
            | "file.read"
            | "content.write"
            | "content.commit"
            | "native.session.cancel"
            | "agent.settings.discover"
            | "session.events.subscribe";
    }
>;
type ClientControlKind = ClientControlCommand["kind"];

function answeredBy<Kind extends keyof typeof daemonToRelayDecoders>(kind: Kind) {
    return { kind, decode: daemonToRelayDecoders[kind] };
}

/** The one native success reply that answers each command. */
const computerControlAnswers = {
    "computer.diagnostics.read": answeredBy("computer.diagnostics.result"),
    "computer.ping": answeredBy("computer.pong"),
    "native.session.request": answeredBy("native.session.result"),
    "session.prepare": answeredBy("session.ready"),
    "session.create": answeredBy("session.ready"),
    "session.configure": answeredBy("session.config.updated"),
    "session.config.read": answeredBy("session.config.read.result"),
    "session.rename": answeredBy("session.renamed"),
    "session.archive": answeredBy("session.archived"),
    "session.cancel-before-start": answeredBy("session.turn.withdrawn"),
    "session.cancel": answeredBy("session.turn.stopped"),
    "session.prompt.disposition": answeredBy("session.prompt.steered"),
    "session.prompt": answeredBy("session.prompt.accepted"),
    "session.preview-history.page.load": answeredBy("session.preview-history.page.loaded"),
    "session.live-history.v2.page.load": answeredBy("session.live-history.v2.page.loaded"),
    "session.elicitation.respond": answeredBy("session.interaction.answered"),
    "session.permission.respond": answeredBy("session.interaction.answered"),
    "session.list": answeredBy("session.listed"),
    "session.query": answeredBy("session.queried"),
    "session.restore": answeredBy("session.restored"),
    "workspace.list": answeredBy("workspace.entries"),
} satisfies { readonly [K in ClientControlKind]: { readonly kind: string } };

/** The success reply that answers a command of kind `K`. */
export type ClientControlSuccess<K extends ClientControlKind> = ReturnType<
    (typeof computerControlAnswers)[K]["decode"]
>;
/** The failure the Computer reports for any command; its code and message are the Computer's, sealed for the client. */
type ComputerOperationFailure = ReturnType<(typeof daemonToRelayDecoders)["session.operation.failed"]>;
/** Everything that answers a command of kind `K`: its own success reply, or the Computer's failure. */
export type ClientControlReply<K extends ClientControlKind> = ClientControlSuccess<K> | ComputerOperationFailure;

export const computerControlSuccess: {
    readonly [K in ClientControlKind]: {
        readonly kind: string;
        readonly decode: (message: string) => ClientControlSuccess<K>;
    };
} = computerControlAnswers;

export function computerControlTarget(command: ClientControlCommand): NativeSessionTarget | undefined {
    switch (command.kind) {
        case "native.session.request":
            return command.action === "list" ? undefined : command.target;
        case "session.prepare":
        case "session.configure":
        case "session.config.read":
        case "session.rename":
        case "session.archive":
        case "session.cancel-before-start":
        case "session.cancel":
        case "session.prompt.disposition":
        case "session.prompt":
        case "session.preview-history.page.load":
        case "session.live-history.v2.page.load":
        case "session.elicitation.respond":
        case "session.permission.respond":
        case "session.restore":
            return command.target;
        case "computer.diagnostics.read":
        case "computer.ping":
        case "session.create":
        case "session.list":
        case "session.query":
        case "workspace.list":
            return undefined;
    }
}
