import type {
    AgentPromptResponse,
    ContentBlock,
    NativeSessionTarget,
    PromptDispatch,
    PromptExecutionContext,
    SessionCapabilities,
    SessionCloseNoticeEvent,
    SessionCommand,
    SessionConfigOption,
    SessionConfigurationSelection,
    SessionElicitationRespondCommand,
    SessionLiveEvent,
    SessionPermissionRespondCommand,
} from "@portalcrew/morty-client/protocol";
import type { AcpAgentDefinition } from "../../acp/agent/agent-definition.ts";
import type { AgentModelEffort } from "../../acp/agent/model-effort.ts";
import type { PromptImageInput, PromptResourceInput } from "../../acp/client/prompt-content.ts";
import type { AcpContentExternalizer } from "../../acp/content/content-externalizer.ts";
import type { Adapter } from "../../acp/native-history/preview-contract.ts";
import type { NativeSessionOrigin } from "../../acp/protocol/native-session.ts";
import type { SessionCreationIdentity } from "../record/session-store.ts";

export interface SessionCreationOptions {
    readonly adapter: Adapter;
    readonly agent: AcpAgentDefinition;
    readonly cwd: string;
    readonly signal: AbortSignal;
    readonly externalizeSessionUpdate?: AcpContentExternalizer["update"];
}

export interface SessionPrepareOptions extends SessionCreationOptions {
    readonly target: NativeSessionTarget;
    readonly origin?: NativeSessionOrigin;
}

/** A fork is a creation operation of its own: it is held under that operation's identity, as a created Session is. */
export type NativeSessionOpening =
    | Extract<NativeSessionOrigin, { readonly kind: "import" }>
    | (Extract<NativeSessionOrigin, { readonly kind: "fork" }> & { readonly creation: SessionCreationIdentity });

export interface CreatedSession {
    readonly target: NativeSessionTarget;
    readonly prepared: PreparedSession;
}

export type SessionRecovery = { readonly kind: "history-required" } | { readonly kind: "interactive-only" };

export interface AgentSettingsInspectionOptions {
    readonly adapter: Adapter;
    readonly agent: AcpAgentDefinition;
    readonly cwd: string;
    readonly model?: string;
    readonly signal: AbortSignal;
}

export type SessionConfigurationChange = SessionPrepareOptions &
    SessionConfigurationSelection & { readonly requestId: string };

export type SessionConfigureOptions = SessionConfigurationChange & {
    readonly expectedConfigurationRevision: string;
};

interface PromptContentOptions {
    readonly images: readonly PromptImageInput[];
    readonly lifecycle?: {
        readonly context?: PromptExecutionContext;
        readonly attemptId: string;
        readonly content: readonly ContentBlock[];
        readonly dispatch: PromptDispatch;
    };
    readonly prompt: string;
    readonly resources: readonly PromptResourceInput[];
}

export interface SessionTurnOptions extends SessionPrepareOptions, PromptContentOptions {
    readonly commandId: string;
}

export interface SessionSteerOptions extends SessionPrepareOptions, PromptContentOptions {
    readonly commandId: string;
    readonly targetCommandId: string;
}

/** A command without the fields that only identify its request, kept distributive over a union's variants. */
type AnswerOf<Command> = Command extends unknown ? Omit<Command, "kind" | "requestId"> : never;

export type PermissionResponseOptions = AnswerOf<SessionPermissionRespondCommand>;

export type ElicitationResponseOptions = AnswerOf<SessionElicitationRespondCommand>;

export type PromptResult = AgentPromptResponse;

export interface SessionObserver {
    readonly onBackgroundActivity?: () => void;
    readonly onSessionEvent?: (event: SessionLiveEvent) => void;
}

export interface SessionConfigurationSnapshot {
    readonly configOptions: readonly SessionConfigOption[];
    readonly configurationRevision: string;
}

export class PreparedSession {
    readonly agentName: string;
    readonly agentVersion: string;
    readonly capabilities: SessionCapabilities;
    readonly commands: readonly SessionCommand[];
    readonly configOptions: readonly SessionConfigOption[];
    readonly configurationRevision: string;

    constructor(
        agentName: string,
        agentVersion: string,
        capabilities: SessionCapabilities,
        commands: readonly SessionCommand[],
        configOptions: readonly SessionConfigOption[],
        configurationRevision: string,
    ) {
        this.agentName = agentName;
        this.agentVersion = agentVersion;
        this.capabilities = capabilities;
        this.commands = commands;
        this.configOptions = configOptions;
        this.configurationRevision = configurationRevision;
    }
}

export type AgentSettingsModelEffort =
    | { readonly kind: "complete"; readonly value: AgentModelEffort }
    | { readonly kind: "unavailable" };

export class AgentSettingsSnapshot {
    readonly agentName: string;
    readonly agentVersion: string;
    readonly configOptions: readonly SessionConfigOption[];
    readonly modelEffort: AgentSettingsModelEffort;

    constructor(
        agentName: string,
        agentVersion: string,
        configOptions: readonly SessionConfigOption[],
        modelEffort: AgentSettingsModelEffort,
    ) {
        this.agentName = agentName;
        this.agentVersion = agentVersion;
        this.configOptions = configOptions;
        this.modelEffort = modelEffort;
    }
}

// What the runtime supplies to the session layer. The session layer never imports the runtime.

export type ResolveAgent = (
    harness: string,
    signal: AbortSignal,
) => Promise<{
    readonly agent: AcpAgentDefinition;
    readonly adapter: Adapter;
    readonly externalizeSessionUpdate?: AcpContentExternalizer["update"];
}>;

/** Records a failure's code and correlation identifiers in the local diagnostics log, never its text. */
export type ReportFailure = (event: string, requestId: string, details: Readonly<Record<string, string>>) => void;

export interface SessionEventSink {
    readonly publish: (event: SessionLiveEvent) => void;
    readonly publishClosed: (event: SessionCloseNoticeEvent) => void;
}
