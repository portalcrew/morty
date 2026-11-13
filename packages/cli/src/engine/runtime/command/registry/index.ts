import { E2EError } from "@morty-build/client";
import { contentChunkCodec, decodeRelayToDaemonMessage } from "@morty-build/client/protocol";
import { createAgentSettingsDiscoveryHandler } from "../agent-settings-discovery.ts";
import type { CommandContext } from "../context.ts";
import type { DaemonCommand } from "../definition.ts";
import { createNativeSessionRequestHandler } from "../native-session-requests.ts";
import { reportAuthenticatedCapacity } from "./capacity.ts";
import { handleComputerDiagnostics, handleComputerPing } from "./computer.ts";
import { createContentWriteCommands } from "./content-write/index.ts";
import { createFileReadCommands } from "./file-read/index.ts";
import { handlePreviewHistoryPageLoad, handleSessionHistoryPageLoad } from "./history.ts";
import {
    handleElicitationRespond,
    handlePermissionRespond,
    handlePromptDisposition,
    handleSessionArchive,
    handleSessionCancel,
    handleSessionCancelBeforeStart,
} from "./interactions.ts";
import { handleSessionList, handleSessionQuery } from "./native-sessions.ts";
import { handleSessionPrompt } from "./prompt.ts";
import {
    handleSessionConfigRead,
    handleSessionConfigure,
    handleSessionCreate,
    handleSessionPrepare,
    handleSessionRename,
    handleSessionRestore,
    handleWorkspaceList,
} from "./session.ts";

export function createCommandRegistry(context: CommandContext): {
    readonly dispatch: (message: DaemonCommand) => void | Promise<void>;
    readonly dispatchChunk: (message: unknown, signal: AbortSignal) => Promise<void>;
    readonly reportCapacity: (encoded: string) => Promise<boolean>;
    readonly settle: () => Promise<void>;
} {
    const contentWrites = createContentWriteCommands(context);
    const fileReads = createFileReadCommands(context);
    const nativeRequests = createNativeSessionRequestHandler(context);
    const agentSettings = createAgentSettingsDiscoveryHandler(context);
    return {
        reportCapacity: async (encoded) => {
            const routing = decodeRelayToDaemonMessage(encoded);
            if (
                (routing.kind === "content.write" || routing.kind === "content.commit") &&
                (await contentWrites.rejectCapacity(routing.requestId, routing.target))
            ) {
                return true;
            }
            return await reportAuthenticatedCapacity(context, encoded);
        },
        dispatch: (message): void | Promise<void> => {
            switch (message.kind) {
                case "session.events.subscribe":
                    return context.subscriptions.subscribe(message);
                case "session.events.unsubscribe":
                    return context.subscriptions.unsubscribe(message);
                case "computer.diagnostics.read":
                    return handleComputerDiagnostics(context, message);
                case "computer.ping":
                    return handleComputerPing(context, message);
                case "session.live-history.v2.page.load":
                    return handleSessionHistoryPageLoad(context, message);
                case "session.preview-history.page.load":
                    return handlePreviewHistoryPageLoad(context, message);
                case "native.session.cancel":
                    nativeRequests.cancel(message.requestId);
                    return;
                case "worker.request.cancel":
                    nativeRequests.cancel(message.requestId);
                    contentWrites.cancel(message.requestId);
                    fileReads.cancel(message.requestId);
                    return;
                case "worker.file.credit":
                    fileReads.credit(message.requestId);
                    return;
                case "native.session.request":
                    return nativeRequests.handle(message);
                case "session.list":
                    return handleSessionList(context, message);
                case "session.query":
                    return handleSessionQuery(context, message);
                case "agent.settings.discover":
                    agentSettings.handle(message);
                    return;
                case "content.write":
                    return contentWrites.write(message);
                case "content.commit":
                    return contentWrites.commit(message);
                case "file.read":
                    return fileReads.read(message);
                case "session.cancel-before-start":
                    return handleSessionCancelBeforeStart(context, message);
                case "session.cancel":
                    return handleSessionCancel(context, message);
                case "session.archive":
                    return handleSessionArchive(context, message);
                case "session.prompt.disposition":
                    return handlePromptDisposition(context, message);
                case "workspace.list":
                    return handleWorkspaceList(context, message);
                case "session.prepare":
                    return handleSessionPrepare(context, message);
                case "session.create":
                    return handleSessionCreate(context, message);
                case "session.configure":
                    return handleSessionConfigure(context, message);
                case "session.config.read":
                    return handleSessionConfigRead(context, message);
                case "session.rename":
                    return handleSessionRename(context, message);
                case "session.restore":
                    return handleSessionRestore(context, message);
                case "session.permission.respond":
                    return handlePermissionRespond(context, message);
                case "session.elicitation.respond":
                    return handleElicitationRespond(context, message);
                case "session.prompt":
                    return handleSessionPrompt(context, message);
                default:
                    message satisfies never;
            }
        },
        dispatchChunk: async (message, signal): Promise<void> => {
            // A future binary format must not disconnect unrelated Sessions.
            // Validate the whole frame before passing any bytes to an upload.
            const frame = await (async () => {
                try {
                    return await contentChunkCodec.decode(message, context.payloadEncryption, signal);
                } catch (error) {
                    signal.throwIfAborted();
                    if (error instanceof E2EError && error.code === "e2e_store_busy") {
                        const routing = contentChunkCodec.decodeRouting(message);
                        if (!(await contentWrites.rejectCapacity(routing.requestId, undefined))) {
                            throw error;
                        }
                        return null;
                    }
                    context.diagnostics.daemonDiagnostic("content_frame_discarded", "unknown", {
                        reason: "unsupported_frame",
                    });
                    return null;
                }
            })();
            if (frame !== null) {
                await contentWrites.receiveChunk(frame);
            }
        },
        settle: async (): Promise<void> => {
            await Promise.all([
                contentWrites.settle(),
                fileReads.settle(),
                nativeRequests.settle(),
                agentSettings.settle(),
            ]);
        },
    };
}
