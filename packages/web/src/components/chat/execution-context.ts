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
    | {
          readonly kind: "action-required";
          readonly title: string;
          readonly description: string;
      }
    | { readonly kind: "closed"; readonly description: string };
