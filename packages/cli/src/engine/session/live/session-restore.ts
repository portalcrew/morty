import type { NativeSessionTarget, SessionCapabilities } from "@portalcrew/morty-client/protocol";
import { AcpExecutionError } from "../../acp/acp-error.ts";
import { type NativeSessionOrigin, sessionIdSchema } from "../../acp/protocol/native-session.ts";
import type { SessionRecovery } from "../api/session-api.ts";
import { StoredSession } from "../record/session-store.ts";

/**
 * The established native conversation a reopened Session continues: the one the Runtime recorded, or the one an
 * import names. Reopening never creates or assigns a destination.
 */
export function restoredConversation(
    recorded: StoredSession | undefined,
    target: NativeSessionTarget,
    cwd: string,
    origin: NativeSessionOrigin | undefined,
    importedAt: string,
): StoredSession {
    if (origin?.kind === "fork") {
        throw new AcpExecutionError(
            "A fork must obtain its destination from the harness",
            {},
            "invalid_native_session_request",
        );
    }
    const stored =
        origin?.kind === "import"
            ? new StoredSession(
                  { harness: target.harness, sessionId: sessionIdSchema.parse(origin.sessionId) },
                  cwd,
                  true,
                  origin.title,
                  importedAt,
              )
            : recorded;
    if (stored === undefined) {
        throw new AcpExecutionError("The native Session was not found", {}, "session_not_found");
    }
    if (stored.cwd !== cwd) {
        throw new AcpExecutionError("The native Session workspace cannot change", {}, "session_identity_mismatch");
    }
    return stored;
}

export function restoreOpening(recovery: SessionRecovery, capabilities: SessionCapabilities): "resume" | "replay" {
    if (recovery.kind === "history-required") {
        if (!capabilities.loadSession) {
            throw new AcpExecutionError(
                "This Agent restores context but does not provide message history.",
                {},
                "native_history_unsupported",
            );
        }
        return "replay";
    }
    if (capabilities.resumeSession) {
        return "resume";
    }
    if (capabilities.loadSession) {
        return "replay";
    }
    throw new AcpExecutionError("The harness cannot restore its native Session", {}, "session_restore_unsupported");
}
