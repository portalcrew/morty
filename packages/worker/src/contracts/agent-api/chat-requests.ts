import {
    type AgentSettingsDiscoverCommandRouting,
    agentSettingsDiscoverCommandCodec,
    type ComputerDiagnosticsRequestRouting,
    type ComputerMetadataRequestRouting,
    type ComputerPingCommandRouting,
    computerDiagnosticsRequestCodec,
    computerMetadataRequestCodec,
    computerPingCommandCodec,
    type NativeSessionCommandRouting,
    nativeSessionCommandCodec,
    type SessionArchiveCommandRouting,
    type SessionCreateCommandRouting,
    type SessionListCommandRouting,
    type SessionPrepareCommandRouting,
    type SessionPreviewHistoryPageLoadRouting,
    type SessionRestoreCommandRouting,
    sessionArchiveCommandCodec,
    sessionCreateCommandCodec,
    sessionListCommandCodec,
    sessionPrepareCommandCodec,
    sessionPreviewHistoryPageLoadCodec,
    sessionRestoreCommandCodec,
    type WorkspaceListCommandRouting,
    workspaceListCommandCodec,
} from "@morty-build/client/protocol";
import * as v from "valibot";

// The request bodies the Chat API accepts. Its routes validate with these schemas, and the published agent API
// description is generated from them.

export const setupInput = v.custom<AgentSettingsDiscoverCommandRouting>((value) => {
    try {
        agentSettingsDiscoverCommandCodec.decodeRouting(JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
}, "An encrypted Agent settings request is required.");
export const diagnosticsInput = v.custom<ComputerDiagnosticsRequestRouting>((value) => {
    try {
        computerDiagnosticsRequestCodec.decodeRouting(JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
}, "An encrypted diagnostics request is required.");
export const metadataInput = v.custom<ComputerMetadataRequestRouting>((value) => {
    try {
        computerMetadataRequestCodec.decodeRouting(JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
}, "An encrypted metadata request is required.");
export const networkDiagnosticInput = v.custom<ComputerPingCommandRouting>((value) => {
    try {
        computerPingCommandCodec.decodeRouting(JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
}, "An encrypted Computer ping is required.");
export const managedSessionsInput = v.custom<SessionListCommandRouting>((value) => {
    try {
        sessionListCommandCodec.decodeRouting(JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
}, "An encrypted Session list request is required.");
export const directoryInput = v.custom<WorkspaceListCommandRouting>((value) => {
    try {
        workspaceListCommandCodec.decodeRouting(JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
}, "An encrypted directory request is required.");
export const restoreSessionInput = v.custom<SessionRestoreCommandRouting>((value) => {
    try {
        sessionRestoreCommandCodec.decodeRouting(JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
}, "An encrypted Session restore request is required.");
export const archiveSessionInput = v.custom<SessionArchiveCommandRouting>((value) => {
    try {
        sessionArchiveCommandCodec.decodeRouting(JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
}, "An encrypted Session archive request is required.");
export const nativeListInput = v.custom<Extract<NativeSessionCommandRouting, { readonly action: "list" }>>((value) => {
    try {
        return nativeSessionCommandCodec.decodeRouting(JSON.stringify(value)).action === "list";
    } catch {
        return false;
    }
}, "An encrypted native Session list request is required.");
export const nativeImportInput = v.custom<Extract<NativeSessionCommandRouting, { readonly action: "import" }>>(
    (value) => {
        try {
            return nativeSessionCommandCodec.decodeRouting(JSON.stringify(value)).action === "import";
        } catch {
            return false;
        }
    },
    "An encrypted native Session import request is required.",
);
export const nativeContinuationCommandInput = v.custom<
    Extract<NativeSessionCommandRouting, { readonly action: "find" | "import" }>
>((value) => {
    try {
        const command = nativeSessionCommandCodec.decodeRouting(JSON.stringify(value));
        return command.action === "find" || command.action === "import";
    } catch {
        return false;
    }
}, "An encrypted Session continuation request is required.");
export const nativeForkInput = v.custom<Extract<NativeSessionCommandRouting, { readonly action: "fork" }>>((value) => {
    try {
        return nativeSessionCommandCodec.decodeRouting(JSON.stringify(value)).action === "fork";
    } catch {
        return false;
    }
}, "An encrypted native Session fork request is required.");
export const nativePreviewInput = v.custom<SessionPreviewHistoryPageLoadRouting>((value) => {
    try {
        sessionPreviewHistoryPageLoadCodec.decodeRouting(JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
}, "An encrypted Session preview request is required.");
export const sessionAccessInput = v.custom<SessionPrepareCommandRouting>((value) => {
    try {
        sessionPrepareCommandCodec.decodeRouting(JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
}, "An encrypted Session access request is required.");
/** The client owns Session creation; the Worker authorizes only its declared route. */
export const accessInput = v.custom<SessionCreateCommandRouting>((value) => {
    try {
        sessionCreateCommandCodec.decodeRouting(JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
}, "An encrypted Session creation request is required.");
