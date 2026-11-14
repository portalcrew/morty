import type { NativeSessionTarget, PromptCompletion } from "@morty-build/client/protocol";
import { WebSocket } from "undici";
import type { ExecutionReceipts } from "../../session/turn/execution-receipts.ts";
import type { CommandContext } from "./context.ts";
import { replyFailure, send } from "./transport.ts";

/** How a settled command ended, as the ledger's outcome records it. */
export type SettledCommand =
    | { readonly kind: "completed"; readonly completion: PromptCompletion }
    | { readonly kind: "failed"; readonly code: string; readonly message: string }
    | { readonly kind: "unavailable" };

export function settledCommand(operations: ExecutionReceipts, commandId: string): SettledCommand {
    const outcome = operations.outcome(commandId);
    if (outcome?.type !== "lifecycle-metadata") {
        return { kind: "unavailable" };
    }
    const payload = outcome.payload;
    switch (payload.kind) {
        case "prompt.completed":
            return { kind: "completed", completion: payload.completion };
        case "prompt.failed":
        case "prompt.failed-before-start":
            return { kind: "failed", code: payload.code, message: payload.message };
        default:
            return { kind: "unavailable" };
    }
}

/** A reply that outlives its connection has no reader. */
export function reply(socket: WebSocket, encoded: string | Uint8Array): void {
    if (socket.readyState === WebSocket.OPEN) {
        send(socket, encoded);
    }
}

/** Answers a request with a settled command's failure, or with the loss of its outcome. */
export async function replySettledFailure(
    context: Pick<CommandContext, "socket" | "payloadEncryption" | "signal">,
    requestId: string,
    target: NativeSessionTarget,
    settled: Exclude<SettledCommand, { readonly kind: "completed" }>,
): Promise<void> {
    if (settled.kind === "failed") {
        await replyFailure(context, requestId, target, settled.code, settled.message);
        return;
    }
    await replyFailure(
        context,
        requestId,
        target,
        "command_result_expired",
        "The command ended, but its result is no longer available.",
    );
}
