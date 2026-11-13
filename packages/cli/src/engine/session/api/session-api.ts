import type {
    AgentModelEffort,
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
} from "@morty-build/client/protocol";
import type { AcpAgentDefinition } from "../../acp/agent/agent-definition.ts";
import type { BackgroundActivity } from "../../acp/agent/agent-lifecycle.ts";
import type { PromptImageInput, PromptResourceInput } from "../../acp/client/prompt-content.ts";
import type { AcpContentExternalizer } from "../../acp/content/content-externalizer.ts";
import type { Adapter } from "../../acp/native-history/preview-contract.ts";
import type { NativeSessionOrigin } from "../../acp/protocol/native-session.ts";

/** A new harness Session has no conversation identity until the harness opens it. */
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
    /** The prompt's native-history behavior when this preparation starts a Session. */
    readonly recovery?: SessionRecovery;
}

/** A Session the Runtime created and holds, with the snapshot of its configured Agent. */
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

/** A setting the Runtime applies on its own authority: a launch, stored or prompt-requested selection. */
export type SessionConfigurationChange = SessionPrepareOptions &
    SessionConfigurationSelection & { readonly requestId: string };

/** A client's edit, which applies only while the configuration still has the revision it was chosen from. */
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
    readonly onBackgroundActivity?: (source: object, activity: BackgroundActivity) => void;
    readonly onSessionEvent?: (event: SessionLiveEvent) => Promise<void>;
}

export class NullSessionObserver implements SessionObserver {
    readonly onBackgroundActivity = (_source: object, _activity: BackgroundActivity): void => {};
    readonly onSessionEvent = (_event: SessionLiveEvent): Promise<void> => Promise.resolve();
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
    readonly prompted: boolean;
    readonly restored: boolean;
    readonly configurationRevision: string;

    constructor(
        agentName: string,
        agentVersion: string,
        capabilities: SessionCapabilities,
        commands: readonly SessionCommand[],
        configOptions: readonly SessionConfigOption[],
        prompted: boolean,
        restored: boolean,
        configurationRevision: string,
    ) {
        this.agentName = agentName;
        this.agentVersion = agentVersion;
        this.capabilities = capabilities;
        this.commands = commands;
        this.configOptions = configOptions;
        this.prompted = prompted;
        this.restored = restored;
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

/** Resolves a catalog Agent's current launch definition and its Runtime-owned adapter. */
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

/** Delivers session events to connected clients. The runtime's relay publisher implements it. */
export interface SessionEventSink {
    readonly publish: (event: SessionLiveEvent) => void;
    readonly publishClosed: (event: SessionCloseNoticeEvent) => void;
}
