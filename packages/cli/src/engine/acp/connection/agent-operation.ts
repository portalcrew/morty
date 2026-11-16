import { RequestError } from "@agentclientprotocol/sdk/unstable";
import { z } from "zod";
import { isRecord, truncate } from "../../util/value-utils.ts";
import { AcpExecutionError, AcpPromptExecutionError } from "../acp-error.ts";
import { type AgentTermination, agentTerminationError } from "../agent/agent-lifecycle.ts";

const promptFailureIdentitySchema = z.object({ messageId: z.string().min(1).max(2_048) });

/** Preserve the public error contract for both direct calls and ACP transport. */
export function agentOperationError(error: unknown): unknown {
    if (!(error instanceof RequestError)) {
        return error;
    }
    const code = error.code === -32_000 ? "authentication_required" : "acp_agent_error";
    const message = error.code === -32_000 ? "Agent authentication is required" : requestErrorMessage(error);
    const identity = promptFailureIdentitySchema.safeParse(error.data);
    return identity.success
        ? new AcpPromptExecutionError(identity.data.messageId, message, { cause: error }, code)
        : new AcpExecutionError(message, { cause: error }, code);
}

function requestErrorMessage(error: RequestError): string {
    const fallback = truncate(error.message, 500);
    if (error.message !== "Internal error" || !isRecord(error.data)) {
        return fallback;
    }
    const agentError = error.data["error"];
    if (isRecord(agentError)) {
        const message = agentError["message"];
        if (typeof message === "string" && message.length > 0) {
            return truncate(message, 500);
        }
    }
    const details = error.data["details"];
    return typeof details === "string" && details.length > 0 ? truncate(details, 500) : fallback;
}

export async function raceAgentOperation<T>(
    operation: Promise<T>,
    termination: Promise<AgentTermination>,
    exitMessage: string,
    signal: AbortSignal,
): Promise<T> {
    let removeAbortListener = (): void => {};
    const aborted = new Promise<never>((_resolve, reject) => {
        const rejectAbort = (): void => {
            reject(signal.reason ?? new Error("ACP request was cancelled"));
        };
        signal.addEventListener("abort", rejectAbort, { once: true });
        removeAbortListener = (): void => signal.removeEventListener("abort", rejectAbort);
        if (signal.aborted) {
            rejectAbort();
        }
    });
    try {
        return await Promise.race([
            aborted,
            operation,
            termination.then((result) => {
                const cause = agentTerminationError(result);
                throw new AcpExecutionError(exitMessage, { cause }, cause.code);
            }),
        ]);
    } catch (error) {
        signal.throwIfAborted();
        throw agentOperationError(error);
    } finally {
        removeAbortListener();
    }
}

/** Direct harness calls have no transport termination; only cancellation competes with the result. */
export async function waitForAgentOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return await raceAgentOperation(operation, new Promise<never>(() => undefined), "", signal);
}
