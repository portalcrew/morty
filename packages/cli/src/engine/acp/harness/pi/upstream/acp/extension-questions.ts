import { type ElicitationPropertySchema, RequestError } from "@agentclientprotocol/sdk/unstable";
import { z } from "zod";
import type { PiRpcEvent, PiRpcProcess } from "../pi-rpc/process.js";
import type { PiAcpClient } from "./client.js";

const questionBase = {
    id: z.string().min(1).max(255),
    title: z.string().max(255),
    timeout: z.number().int().nonnegative().max(2_147_483_647).optional(),
};
const questionSchema = z
    .discriminatedUnion("method", [
        z.object({
            ...questionBase,
            method: z.literal("select"),
            options: z.array(z.string().min(1).max(255)).min(1).max(200).readonly(),
        }),
        z.object({ ...questionBase, method: z.literal("confirm"), message: z.string().max(2_000) }),
        z.object({ ...questionBase, method: z.literal("input"), placeholder: z.string().max(500).optional() }),
        z.object({ ...questionBase, method: z.literal("editor"), prefill: z.string().max(10_000).optional() }),
    ])
    .readonly();
type Question = z.infer<typeof questionSchema>;
const QUESTION_TIMEOUT_MS = 3_600_000;

class PiQuestionError extends RequestError {
    constructor(kind: "request_failed" | "invalid_response" | "response_failed", cause?: unknown) {
        const messages = {
            request_failed: "Pi could not request an answer.",
            invalid_response: "Pi received an invalid answer.",
            response_failed: "Pi could not receive the answer.",
        };
        super(-32603, "Internal error", { code: `pi_question_${kind}`, details: messages[kind] });
        this.cause = cause;
    }
}

type QuestionTurn = { readonly controller: AbortController; readonly requestIds: Set<string> };

function questionField(question: Question): ElicitationPropertySchema {
    const title = question.title || "Answer";
    switch (question.method) {
        case "select":
            return { type: "string", title, enum: [...question.options] };
        case "confirm":
            return {
                type: "string",
                title,
                oneOf: [
                    { const: "yes", title: "Yes" },
                    { const: "no", title: "No" },
                ],
            };
        case "input":
            return { type: "string", title, description: question.placeholder, maxLength: 10_000 };
        case "editor":
            return {
                type: "string",
                title,
                default: question.prefill,
                maxLength: 10_000,
                _meta: { "io.morty/multiline": true },
            };
    }
}

export class PiExtensionQuestions {
    private turn: QuestionTurn | null = null;

    constructor(
        private readonly sessionId: string,
        private readonly conn: PiAcpClient,
        private readonly proc: PiRpcProcess,
        private readonly notify: (text: string) => Promise<void>,
    ) {}

    startTurn(): AbortSignal {
        this.endTurn();
        this.turn = { controller: new AbortController(), requestIds: new Set() };
        return this.turn.controller.signal;
    }

    endTurn(reason?: RequestError): void {
        this.turn?.controller.abort(reason);
        this.turn = null;
    }

    async handle(event: PiRpcEvent): Promise<void> {
        // Status, widget, title and editor updates are fire-and-forget in Pi RPC.
        if (
            event.method !== "select" &&
            event.method !== "confirm" &&
            event.method !== "input" &&
            event.method !== "editor"
        ) {
            return;
        }
        if (typeof event.id !== "string" || event.id.length === 0 || event.id.length > 255) {
            return;
        }
        const turn = this.turn;
        if (turn?.requestIds.has(event.id)) {
            return;
        }
        turn?.requestIds.add(event.id);
        try {
            await this.answer(event, turn);
        } catch (cause) {
            // Intentional disposal has already cancelled the owning operation. A live
            // transport write failure must fail that operation, not a later turn.
            if (!this.proc.signal.aborted) {
                turn?.controller.abort(new PiQuestionError("response_failed", cause));
                this.proc.terminateAfterFailure(cause);
            }
        }
    }

    private async answer(event: PiRpcEvent, turn: QuestionTurn | null): Promise<void> {
        const id = typeof event.id === "string" ? event.id : "";
        const parsed = questionSchema.safeParse(event);
        if (!parsed.success) {
            await this.notify(
                "Pi requested a question with unsupported or oversized fields. The question was cancelled without changing its content.",
            );
            await this.proc.sendExtensionUiResponse({ id, cancelled: true });
            return;
        }
        const question = parsed.data;
        if (turn === null || turn.controller.signal.aborted) {
            await this.proc.sendExtensionUiResponse({ id: question.id, cancelled: true });
            return;
        }
        const deadline = new AbortController();
        const timeout = setTimeout(() => deadline.abort(), question.timeout || QUESTION_TIMEOUT_MS);
        const signal = AbortSignal.any([turn.controller.signal, deadline.signal]);
        let response: Parameters<PiRpcProcess["sendExtensionUiResponse"]>[0] = { id: question.id, cancelled: true };
        try {
            const answer = await this.conn.requestElicitation(
                {
                    sessionId: this.sessionId,
                    mode: "form",
                    message: (question.method === "confirm" ? question.message : "") || question.title || "Pi question",
                    requestedSchema: {
                        type: "object",
                        properties: { value: questionField(question) },
                        required: ["value"],
                    },
                },
                signal,
            );
            const content: unknown = answer.action === "accept" ? answer.content : undefined;
            const value = typeof content === "object" && content !== null ? Reflect.get(content, "value") : undefined;
            if (!signal.aborted && answer.action === "accept") {
                if (typeof value !== "string") {
                    throw new PiQuestionError("invalid_response");
                }
                switch (question.method) {
                    case "select":
                        if (!question.options.includes(value)) {
                            throw new PiQuestionError("invalid_response");
                        }
                        response = { id: question.id, value };
                        break;
                    case "confirm":
                        if (value !== "yes" && value !== "no") {
                            throw new PiQuestionError("invalid_response");
                        }
                        response = { id: question.id, confirmed: value === "yes" };
                        break;
                    case "input":
                    case "editor":
                        if (value.length > 10_000) {
                            throw new PiQuestionError("invalid_response");
                        }
                        response = { id: question.id, value };
                        break;
                }
            } else if (!signal.aborted && answer.action !== "cancel" && answer.action !== "decline") {
                throw new PiQuestionError("invalid_response");
            }
        } catch (cause) {
            if (!signal.aborted && !(cause instanceof RequestError && cause.code === -32800)) {
                turn.controller.abort(
                    cause instanceof PiQuestionError ? cause : new PiQuestionError("request_failed", cause),
                );
            }
        } finally {
            clearTimeout(timeout);
        }
        if (deadline.signal.aborted && signal.reason === deadline.signal.reason) {
            await this.notify("Pi question timed out; no answer was submitted.");
        }
        await this.proc.sendExtensionUiResponse(response);
    }
}
