import type {
    CompleteElicitationNotification,
    CreateElicitationRequest,
    CreateElicitationResponse,
    RequestPermissionRequest,
    RequestPermissionResponse,
    SessionUpdate,
} from "@agentclientprotocol/sdk/unstable";
import {
    type AcpSessionUpdate,
    decodeAcpSessionUpdate,
    type SessionCommand,
    type SessionConfigOption,
    type SessionPromptSuggestions,
} from "@portalcrew/morty-client/protocol";
import { truncate } from "../../util/value-utils.ts";
import type { BackgroundActivity, PromptDelegationStage } from "../agent/agent-lifecycle.ts";
import { normalizeSessionConfigurationUpdate } from "../protocol/session-configuration.ts";

type NativeSessionInfoChange =
    | { readonly kind: "title"; readonly value: string }
    | { readonly kind: "updated-at"; readonly value: string };

export interface NativeSessionInteractions {
    readonly onPermission: (
        request: RequestPermissionRequest,
        signal: AbortSignal,
    ) => Promise<RequestPermissionResponse>;
    readonly onElicitation: (
        request: CreateElicitationRequest,
        signal: AbortSignal,
    ) => Promise<CreateElicitationResponse>;
    readonly onElicitationComplete: (notification: CompleteElicitationNotification) => Promise<void>;
}

/** A turn started by another client on the attached native session. */
export interface ObservedAgentTurn {
    readonly commandId: string;
    readonly completion: Promise<string>;
}
export interface NativeSessionSubscriber {
    readonly onObservedTurn?: (sessionId: string, turn: ObservedAgentTurn) => Promise<void> | void;
    readonly onSessionEvent: (sessionId: string, event: NativeSessionEvent) => Promise<void>;
    readonly onBackgroundActivity?: (activity: BackgroundActivity) => void;
    readonly onPromptDelegation?: (stage: PromptDelegationStage) => Promise<void>;
    /** ACP keeps prompt suggestions out of a Session's history, so they reach the Session apart from its events. */
    readonly onPromptSuggestions?: (
        sessionId: string,
        suggestions: SessionPromptSuggestions["suggestions"],
    ) => Promise<void>;
    readonly interactions: NativeSessionInteractions;
}

export type NativeSessionEvent =
    | { readonly kind: "content" | "other"; readonly payload: AcpSessionUpdate }
    | { readonly kind: "commands"; readonly commands: readonly SessionCommand[]; readonly payload: AcpSessionUpdate }
    | {
          readonly kind: "configuration";
          readonly configOptions: readonly SessionConfigOption[];
          readonly payload: AcpSessionUpdate;
      }
    | { readonly kind: "mode"; readonly modeId: string; readonly payload: AcpSessionUpdate }
    | {
          readonly kind: "info";
          readonly changes: readonly NativeSessionInfoChange[];
          readonly payload: AcpSessionUpdate;
      };

export function nativeSessionEvent(update: SessionUpdate, value: unknown = update): NativeSessionEvent {
    const payload = decodeAcpSessionUpdate(JSON.stringify(withMortyFields(update, value)));
    switch (update.sessionUpdate) {
        case "available_commands_update":
            return {
                kind: "commands",
                payload,
                commands: update.availableCommands
                    .slice(0, 500)
                    .map((command) => ({
                        name: truncate(command.name, 128),
                        description: truncate(command.description, 500),
                        inputHint: truncate(command.input?.hint ?? "", 255),
                    }))
                    .filter((command) => command.name.length > 0),
            };
        case "config_option_update":
            return {
                kind: "configuration",
                payload,
                configOptions: normalizeSessionConfigurationUpdate([], update.configOptions),
            };
        case "current_mode_update":
            return { kind: "mode", payload, modeId: update.currentModeId };
        case "session_info_update": {
            const changes: NativeSessionInfoChange[] = [];
            if (Object.hasOwn(update, "title")) {
                changes.push({ kind: "title", value: truncate(update.title ?? "", 500) });
            }
            if (Object.hasOwn(update, "updatedAt")) {
                changes.push({ kind: "updated-at", value: truncate(update.updatedAt ?? "", 128) });
            }
            return {
                kind: "info",
                payload,
                changes,
            };
        }
        case "user_message_chunk":
        case "agent_message_chunk":
        case "agent_thought_chunk":
        case "tool_call":
        case "tool_call_update":
        case "plan":
            return { kind: "content", payload };
        default:
            return { kind: "other", payload };
    }
}

function withMortyFields(update: SessionUpdate, eventUpdate: unknown): unknown {
    if (typeof eventUpdate !== "object" || eventUpdate === null) {
        return eventUpdate;
    }
    switch (update.sessionUpdate) {
        case "tool_call":
        case "tool_call_update": {
            const backgroundTask = update._meta?.["morty.backgroundTask"];
            return backgroundTask === undefined ? eventUpdate : { ...eventUpdate, backgroundTask };
        }
        case "agent_message_chunk": {
            const questions = update._meta?.["morty.questions"];
            return questions === undefined ? eventUpdate : { ...eventUpdate, questions };
        }
        default:
            return eventUpdate;
    }
}
