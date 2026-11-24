import type { PayloadEncryptionConnection } from "@portalcrew/morty-client";
import type { WebSocket } from "undici";
import type { ResolveAgent } from "../../session/api/session-api.ts";
import type { ExternalContentStore } from "../../session/content/external-content-store.ts";
import type { SessionManager } from "../../session/manager/session-manager.ts";
import type { NativeSessionService } from "../../session/native/native-session-browser.ts";
import type { PromptLifecycle } from "../../session/prompt/prompt-lifecycle.ts";
import type { SessionCreations } from "../../session/record/session-creations.ts";
import type { CommandStandings } from "../../session/turn/command-standings.ts";
import type { ExecutionReceipts } from "../../session/turn/execution-receipts.ts";
import type { SessionTurns } from "../../session/turn/session-turns.ts";
import type { WorkspaceDirectoryService } from "../../session/workspace/workspace-directory.ts";
import type { Timer } from "../../util/timer.ts";
import type { ComputerUpdate } from "../computer-update.ts";
import type { RuntimeConfig } from "../config.ts";
import type { RelayConnectionDiagnostics } from "../relay/diagnostics.ts";
import type { createSessionSubscriptions } from "./registry/subscriptions.ts";

export interface CommandContext {
    readonly payloadEncryption: PayloadEncryptionConnection;
    readonly subscriptions: ReturnType<typeof createSessionSubscriptions>;
    readonly sessionCreations: SessionCreations;
    readonly resolveAgent: ResolveAgent;
    readonly computerUpdate: ComputerUpdate | null;
    readonly config: RuntimeConfig;
    readonly directories: WorkspaceDirectoryService;
    readonly sessions: SessionManager;
    readonly nativeSessions: NativeSessionService;
    readonly operations: ExecutionReceipts;
    readonly eventProjection: PromptLifecycle;
    readonly externalContent: ExternalContentStore;
    readonly sessionTurns: SessionTurns;
    readonly standings: CommandStandings;
    readonly diagnostics: RelayConnectionDiagnostics;
    readonly socket: WebSocket;
    readonly signal: AbortSignal;
    readonly timer: Timer;
}

export type CommandServices = Pick<
    CommandContext,
    | "resolveAgent"
    | "computerUpdate"
    | "directories"
    | "sessions"
    | "sessionCreations"
    | "nativeSessions"
    | "operations"
    | "eventProjection"
    | "externalContent"
    | "sessionTurns"
    | "standings"
>;
