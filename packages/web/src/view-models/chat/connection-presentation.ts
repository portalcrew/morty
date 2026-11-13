import type { ConnectionFeedback, ExecutionContext } from "../../components/chat/execution-context.ts";
import { botConnectionStatus, type ComputerStatusStore } from "./computer-status-store.ts";
import type { ConversationSelectionState } from "./conversation-selection-machine.ts";
import type { SessionConnection } from "./session-connection.ts";

/** A computer goes offline when it sleeps, loses its network, or restarts; only a restart needs the user to start Morty again. */
const COMPUTER_OFFLINE_RECOVERY = "Make sure it’s awake and online. Your draft is saved.";
/** Starts the daemon, which resumes the saved connection. */
const MORTY_START_COMMAND = "npx @morty-build/cli@latest start";
/** What happened to a revoked computer, and the one step that pairs it again. */
const COMPUTER_REVOKED_RECOVERY =
    "Its connection key was used somewhere else, so Morty disconnected it to keep your account safe. Run the Morty setup prompt on that computer again to reconnect it. Your agent's own sessions stay on that computer.";

type ConnectionPresentation = Pick<
    ExecutionContext,
    "computerStatus" | "lastConfirmed" | "connection" | "indicator" | "feedback" | "available"
>;

/** One projection for the header, details and composer; none infer availability independently. */
export function connectionPresentation(
    status: ComputerStatusStore,
    selection: ConversationSelectionState,
    session: SessionConnection | null,
): ConnectionPresentation {
    const computer = botConnectionStatus(status);
    const computerStatus =
        computer.kind === "connected"
            ? "Online"
            : computer.kind === "disconnected"
              ? "Offline"
              : computer.kind === "unpaired"
                ? "Not paired"
                : computer.kind === "revoked"
                  ? "Disconnected for security"
                  : computer.kind === "connecting"
                    ? "Checking availability"
                    : "Status unavailable";
    const watch = status.configurationWatch;
    const checkedAt =
        watch.kind === "current" ? watch.checkedAt : watch.kind === "unavailable" ? watch.lastCheckedAt : null;
    const lastConfirmed =
        (!status.networkAvailable || watch.kind === "unavailable") &&
        checkedAt !== null &&
        status.computerConfiguration !== null
            ? `Last confirmed ${status.computerConfiguration.computer.online ? "online" : "offline"} at ${new Date(checkedAt).toLocaleTimeString()}`
            : null;
    const connection = sessionLabel(session, selection.kind === "draft");
    const present = (
        indicator: ExecutionContext["indicator"],
        feedback: ConnectionFeedback,
    ): ConnectionPresentation => ({
        computerStatus,
        lastConfirmed,
        connection,
        indicator,
        // Presence can change before the Session stream settles. Keep availability conservative, but let
        // the Session's own recovery lifecycle decide when an interruption needs a composer notice.
        feedback:
            session?.kind === "ready" &&
            status.networkAvailable &&
            computer.kind !== "unpaired" &&
            computer.kind !== "revoked"
                ? { kind: "hidden" }
                : feedback,
        available: indicator.kind === "ready",
    });
    if (session?.kind === "closed") {
        return present(
            { kind: "closed", label: "Session closed" },
            { kind: "closed", description: session.reason ?? "This Session was archived." },
        );
    }
    if (!status.networkAvailable) {
        return present(
            { kind: "offline", label: "No network connection" },
            {
                kind: "waiting",
                title: "No network connection",
                description: "Your draft is saved. We’ll reconnect when your network returns.",
                restartCommand: null,
            },
        );
    }
    if (session?.kind === "failed" || (session?.kind === "disconnected" && session.retry.kind === "exhausted")) {
        return present(
            { kind: "failed", label: "Connection unavailable" },
            {
                kind: "failed",
                title: session.kind === "failed" ? "Connection unavailable" : "Couldn’t reconnect",
                description:
                    session.kind === "failed" ? session.message : "Automatic retries stopped. Your draft is saved.",
            },
        );
    }
    if (computer.kind === "revoked") {
        return present(
            { kind: "offline", label: "Disconnected for security" },
            {
                kind: "action-required",
                title: "This computer was disconnected for your security",
                description: COMPUTER_REVOKED_RECOVERY,
            },
        );
    }
    if (computer.kind === "unpaired") {
        return present(
            { kind: "offline", label: "No computer connected" },
            {
                kind: "waiting",
                title: "Connect a computer",
                description: "Connect your local agent to start chatting.",
                restartCommand: null,
            },
        );
    }
    if ((session?.kind === "disconnected" || session?.kind === "reconnecting") && session.notice === "quiet") {
        return present({ kind: "recovering", label: "Reconnecting" }, { kind: "hidden" });
    }
    if (session?.kind === "disconnected") {
        return present(
            {
                kind: computer.kind === "disconnected" ? "offline" : "recovering",
                label: computer.kind === "disconnected" ? "Computer offline" : "Reconnecting",
            },
            {
                kind: "retrying",
                title: computer.kind === "disconnected" ? "Computer is offline" : "Reconnecting…",
                description:
                    computer.kind === "disconnected"
                        ? COMPUTER_OFFLINE_RECOVERY
                        : "Updates are paused. We’ll retry automatically. Your draft is saved.",
                remainingSeconds: session.retry.kind === "scheduled" ? session.retry.remainingSeconds : null,
                restartCommand: computer.kind === "disconnected" ? MORTY_START_COMMAND : null,
            },
        );
    }
    if (computer.kind === "disconnected") {
        return present(
            { kind: "offline", label: "Computer offline" },
            {
                kind: "waiting",
                title: "Computer is offline",
                description: COMPUTER_OFFLINE_RECOVERY,
                restartCommand: MORTY_START_COMMAND,
            },
        );
    }
    if (session?.kind === "reconnecting") {
        return present(
            { kind: "recovering", label: "Reconnecting" },
            {
                kind: "waiting",
                title: "Reconnecting…",
                description: "Updates are paused. Your draft is saved.",
                restartCommand: null,
            },
        );
    }
    if (computer.kind === "unavailable") {
        if (watch.kind === "unavailable" && watch.notice === "quiet") {
            return present({ kind: "recovering", label: "Reconnecting" }, { kind: "hidden" });
        }
        return present(
            { kind: "unknown", label: "Connection status unavailable" },
            {
                kind: "retrying",
                title: "Connection interrupted",
                description: "You can keep writing. Retry to check the connection.",
                remainingSeconds: null,
                restartCommand: null,
            },
        );
    }
    if (computer.kind === "connecting") {
        return present(
            { kind: "recovering", label: "Checking connection" },
            {
                kind: "waiting",
                title: "Checking connection…",
                description: "You can keep writing while we connect.",
                restartCommand: null,
            },
        );
    }
    if (session?.kind === "first-loading" || (session === null && selection.kind === "loading")) {
        return present({ kind: "recovering", label: "Connecting" }, { kind: "hidden" });
    }
    if (session === null && selection.kind === "failed") {
        return present({ kind: "failed", label: "Session unavailable" }, { kind: "hidden" });
    }
    return present({ kind: "ready", label: "Connection available" }, { kind: "hidden" });
}

function sessionLabel(session: SessionConnection | null, draft: boolean): ExecutionContext["connection"] {
    if (session === null) {
        return draft ? "Not started" : "Unavailable";
    }
    switch (session.kind) {
        case "first-loading":
            return "Connecting";
        case "ready":
            return "Connected";
        case "disconnected":
            return session.retry.kind === "exhausted" ? "Unavailable" : "Reconnecting";
        case "reconnecting":
            return "Reconnecting";
        case "closed":
            return "Closed";
        case "failed":
            return "Unavailable";
    }
}
