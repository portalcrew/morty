import type { AgentQuestion } from "@morty-build/client/protocol";
import type { SessionMessage } from "./session-presentation.ts";

/** The suggested answer the user picked for each question of one message, by the question's position. */
export type AgentQuestionChoices = Readonly<Record<string, string>>;

/**
 * The questions the user can still answer, by the message that asks them: those asked after the user's last message.
 * Anything the user says after a question answers or supersedes it.
 */
export function openAgentQuestions(messages: readonly SessionMessage[]): ReadonlyMap<string, readonly AgentQuestion[]> {
    const open = new Map<string, readonly AgentQuestion[]>();
    for (const message of messages) {
        if (message.role === "user") {
            open.clear();
        } else if (message.presentation.kind === "message" && message.presentation.questions.length > 0) {
            open.set(message.presentation.messageId, message.presentation.questions);
        }
    }
    return open;
}

/**
 * The message that answers the questions an Agent message asks, or null until every question that suggests answers
 * has one picked. A single question is answered with the picked answer alone; several are answered question by
 * question so the Agent can tell which answer is which. Questions without suggested answers are answered in the
 * composer instead.
 */
export function agentQuestionAnswer(questions: readonly AgentQuestion[], choices: AgentQuestionChoices): string | null {
    const answered = questions.flatMap((question, index) =>
        question.options.length === 0 ? [] : [{ answer: choices[index.toString()], question: question.question }],
    );
    if (answered.length === 0 || answered.some((entry) => entry.answer === undefined)) {
        return null;
    }
    return questions.length === 1
        ? (answered[0]?.answer ?? null)
        : answered.map((entry) => `${entry.question}\n${entry.answer ?? ""}`).join("\n\n");
}

/**
 * What a question card shows: the answers picked for it while its questions are open, and whether they make a complete
 * answer to send. An answered card shows no pick: its answer is the user's message that follows it.
 */
export function agentQuestionCard(
    questions: readonly AgentQuestion[],
    answerable: boolean,
    choices: AgentQuestionChoices | undefined,
): { readonly choices: AgentQuestionChoices; readonly ready: boolean } {
    const picked = answerable ? (choices ?? {}) : {};
    return { choices: picked, ready: answerable && agentQuestionAnswer(questions, picked) !== null };
}
