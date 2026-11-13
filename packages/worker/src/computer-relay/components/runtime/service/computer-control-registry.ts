import {
    type ClientToRelayMessage,
    daemonToRelayDecoders,
    type NativeSessionTarget,
} from "@morty-build/client/protocol";

export const computerControlReplyDecoders = {
    "computer.metadata.result": daemonToRelayDecoders["computer.metadata.result"],
    "computer.diagnostics.result": daemonToRelayDecoders["computer.diagnostics.result"],
    "computer.pong": daemonToRelayDecoders["computer.pong"],
    "native.session.result": daemonToRelayDecoders["native.session.result"],
    "session.ready": daemonToRelayDecoders["session.ready"],
    "session.config.updated": daemonToRelayDecoders["session.config.updated"],
    "session.config.read.result": daemonToRelayDecoders["session.config.read.result"],
    "session.renamed": daemonToRelayDecoders["session.renamed"],
    "session.archived": daemonToRelayDecoders["session.archived"],
    "session.turn.withdrawn": daemonToRelayDecoders["session.turn.withdrawn"],
    "session.turn.stopped": daemonToRelayDecoders["session.turn.stopped"],
    "session.prompt.steered": daemonToRelayDecoders["session.prompt.steered"],
    "session.prompt.accepted": daemonToRelayDecoders["session.prompt.accepted"],
    "session.preview-history.page.loaded": daemonToRelayDecoders["session.preview-history.page.loaded"],
    "session.live-history.v2.page.loaded": daemonToRelayDecoders["session.live-history.v2.page.loaded"],
    "session.interaction.answered": daemonToRelayDecoders["session.interaction.answered"],
    "session.listed": daemonToRelayDecoders["session.listed"],
    "session.queried": daemonToRelayDecoders["session.queried"],
    "session.restored": daemonToRelayDecoders["session.restored"],
    "session.operation.failed": daemonToRelayDecoders["session.operation.failed"],
    "workspace.entries": daemonToRelayDecoders["workspace.entries"],
    "agent.settings.discovered": daemonToRelayDecoders["agent.settings.discovered"],
    "agent.settings.discovery.failed": daemonToRelayDecoders["agent.settings.discovery.failed"],
};

export type ClientControlReply = ReturnType<
    (typeof computerControlReplyDecoders)[keyof typeof computerControlReplyDecoders]
>;
export type ClientControlCommand = Exclude<
    ClientToRelayMessage,
    {
        readonly kind:
            | "file.read"
            | "content.write"
            | "content.commit"
            | "native.session.cancel"
            | "session.events.subscribe";
    }
>;

/** Only these native success kinds answer the corresponding commands. */
export const computerControlRegistry = {
    "computer.metadata.read": "computer.metadata.result",
    "computer.diagnostics.read": "computer.diagnostics.result",
    "computer.ping": "computer.pong",
    "native.session.request": "native.session.result",
    "session.prepare": "session.ready",
    "session.create": "session.ready",
    "session.configure": "session.config.updated",
    "session.config.read": "session.config.read.result",
    "session.rename": "session.renamed",
    "session.archive": "session.archived",
    "session.cancel-before-start": "session.turn.withdrawn",
    "session.cancel": "session.turn.stopped",
    "session.prompt.disposition": "session.prompt.steered",
    "session.prompt": "session.prompt.accepted",
    "session.preview-history.page.load": "session.preview-history.page.loaded",
    "session.live-history.v2.page.load": "session.live-history.v2.page.loaded",
    "session.elicitation.respond": "session.interaction.answered",
    "session.permission.respond": "session.interaction.answered",
    "session.list": "session.listed",
    "session.query": "session.queried",
    "session.restore": "session.restored",
    "workspace.list": "workspace.entries",
    "agent.settings.discover": "agent.settings.discovered",
} satisfies { readonly [K in ClientControlCommand["kind"]]: keyof typeof computerControlReplyDecoders };

export function computerControlAddress(command: ClientControlCommand): string {
    return command.requestId;
}

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
        case "computer.metadata.read":
        case "computer.ping":
        case "session.create":
        case "session.list":
        case "session.query":
        case "workspace.list":
        case "agent.settings.discover":
            return undefined;
    }
}
