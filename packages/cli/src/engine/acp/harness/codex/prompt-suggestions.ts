import { z } from "zod";
import type { CodexAppServerClient } from "./app-server-client.ts";
import { threadSampleResponseSchema } from "./app-server-protocol.ts";
import type { CodexSessionUpdate } from "./session-update.ts";

// `thread/sample` takes no output schema, so the prompt states the reply's shape.
const SUGGESTION_PROMPT =
    "This request comes from the app; the user did not write it. Predict the single message the user is most likely " +
    "to send next in this conversation. It will appear in their empty message box, where they can send, edit or " +
    "ignore it; it is never sent for them. Continue what they are doing with the most grounded next step, in their " +
    "own voice, as one line of at most 240 characters. Reply with only JSON of the form " +
    '{"suggestion": string | null}, using null only when the conversation offers no grounded next message.';
// The sample inherits the thread's cached context, so the reasoning spent on choosing the next step is the cost.
const SUGGESTION_EFFORT = "high";
const SAMPLE_TIMEOUT_MILLISECONDS = 120_000;
const suggestionReplySchema = z.object({ suggestion: z.string().nullable() });

/**
 * The prompt Codex predicts the user sends next, sampled from a finished turn with `thread/sample`. A Codex that
 * predates that request rejects it, and a rejected or failed sample offers nothing.
 */
export class CodexPromptSuggestions {
    readonly #appServer: CodexAppServerClient;
    readonly #lifetime: AbortSignal;
    readonly #publish: (update: CodexSessionUpdate) => Promise<void>;
    #published: string | null = null;
    #sample: AbortController | null = null;

    constructor(
        appServer: CodexAppServerClient,
        lifetime: AbortSignal,
        publish: (update: CodexSessionUpdate) => Promise<void>,
    ) {
        this.#appServer = appServer;
        this.#lifetime = lifetime;
        this.#publish = publish;
    }

    readonly turnCompleted = (threadId: string, turnId: string): void => {
        this.stop();
        const sample = new AbortController();
        this.#sample = sample;
        const signal = AbortSignal.any([
            sample.signal,
            this.#lifetime,
            AbortSignal.timeout(SAMPLE_TIMEOUT_MILLISECONDS),
        ]);
        void this.#predict(threadId, turnId, signal).catch(() => {});
    };

    /**
     * A prompt spent the prediction: no sample still running may publish one. `null` when none is offered, so a
     * prompt never waits to withdraw nothing.
     */
    readonly withdraw = (): Promise<void> | null => {
        this.stop();
        return this.#published === null ? null : this.#offer(null);
    };

    readonly stop = (): void => {
        this.#sample?.abort();
        this.#sample = null;
    };

    readonly #predict = async (threadId: string, turnId: string, signal: AbortSignal): Promise<void> => {
        const response = threadSampleResponseSchema.parse(
            await this.#appServer.request(
                "thread/sample",
                { effort: SUGGESTION_EFFORT, expectedTurnId: turnId, prompt: SUGGESTION_PROMPT, threadId },
                signal,
            ),
        );
        signal.throwIfAborted();
        await this.#offer(suggestionText(response.text ?? null));
    };

    readonly #offer = async (text: string | null): Promise<void> => {
        if (text === this.#published) {
            return;
        }
        this.#published = text;
        await this.#publish({
            sessionUpdate: "prompt_suggestions_update",
            suggestions: text === null ? [] : [{ prompt: [{ text, type: "text" }] }],
        });
    };
}

function suggestionText(reply: string | null): string | null {
    if (reply === null) {
        return null;
    }
    try {
        const parsed = suggestionReplySchema.safeParse(JSON.parse(reply));
        return parsed.success ? parsed.data.suggestion?.trim() || null : null;
    } catch {
        return null;
    }
}
