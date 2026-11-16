/**
 * Pure display summary of where a session runs. The view-model derives it;
 * the header, details, and composer render the same connection presentation.
 */
export interface ExecutionContext {
    readonly harness: string;
    readonly computer: string;
    readonly agent: string;
    readonly directory: string | null;
    readonly directoryPlaceholder: string;
    readonly computerStatus:
        | "Online"
        | "Offline"
        | "Checking availability"
        | "Status unavailable"
        | "Not paired"
        | "Disconnected for security";
    readonly lastConfirmed: string | null;
    readonly available: boolean;
    readonly feedback: ConnectionFeedback;
    readonly indicator: {
        readonly kind: "ready" | "recovering" | "offline" | "unknown" | "failed" | "closed";
        readonly label: string;
    };
    readonly connection:
        | "Not started"
        | "Connecting"
        | "Connected"
        | "Disconnected"
        | "Reconnecting"
        | "Unavailable"
        | "Closed";
}

/** The command that brings an offline computer back after a restart; null while the computer is not offline. */
type RestartCommand = string | null;

export type ConnectionFeedback =
    | { readonly kind: "hidden" }
    | { readonly kind: "reconnecting"; readonly title: string; readonly description: string }
    | { readonly kind: "attempting"; readonly title: string; readonly description: string }
    | {
          readonly kind: "waiting";
          readonly title: string;
          readonly description: string;
          readonly restartCommand: RestartCommand;
      }
    | {
          readonly kind: "retrying";
          readonly title: string;
          readonly description: string;
          readonly remainingSeconds: number | null;
          readonly restartCommand: RestartCommand;
      }
    | {
          readonly kind: "failed";
          readonly title: string;
          readonly description: string;
      }
    /** The computer needs its owner to act on it; nothing in the browser can restore it. */
    | {
          readonly kind: "action-required";
          readonly title: string;
          readonly description: string;
      }
    | { readonly kind: "closed"; readonly description: string };
