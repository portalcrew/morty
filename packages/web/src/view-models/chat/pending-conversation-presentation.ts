import { botConnectionStatus, type ComputerStatusStore } from "./computer-status-store.ts";
import type { ConversationSelectionState } from "./conversation-selection-machine.ts";
import { selectedConversationTarget } from "./conversation-selection-machine.ts";
import { type SessionTitles, sessionTitle } from "./session-titles-store.ts";

/** A selected conversation is never presented as a new draft while its remote read is pending. */
export function pendingConversationPresentation(
    selection: ConversationSelectionState,
    computer: ComputerStatusStore,
    titles: SessionTitles,
): {
    readonly title: string;
    readonly recovery: { readonly title: string; readonly description: string } | null;
} {
    const sessionTarget = selectedConversationTarget(selection);
    const title = selection.kind === "draft" ? "New session" : sessionTitle(titles, sessionTarget, "Existing session");
    if (
        selection.kind === "draft" ||
        selection.kind === "ready" ||
        (selection.kind === "failed" && (selection.failure === "unavailable" || selection.failure === "agent-required"))
    ) {
        return { title, recovery: null };
    }
    const recoveryTitle = !computer.networkAvailable
        ? "No network connection"
        : botConnectionStatus(computer).kind === "disconnected"
          ? "Computer is offline"
          : computer.configurationWatch.kind === "unavailable" || selection.kind === "failed"
            ? "Connection interrupted"
            : null;
    return {
        title,
        recovery:
            recoveryTitle === null
                ? null
                : {
                      title: recoveryTitle,
                      description: "History is temporarily unavailable. It will load when the connection returns.",
                  },
    };
}
