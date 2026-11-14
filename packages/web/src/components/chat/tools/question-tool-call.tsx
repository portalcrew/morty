import { CircleHelp } from "lucide-react";
import * as v from "valibot";
import { ToolCallDisclosure } from "./tool-call-status.tsx";
import type { ToolRendererProps } from "./tool-renderer.ts";

const textSchema = v.pipe(v.string(), v.maxLength(16_384));
const optionSchema = v.pipe(
    v.strictObject({
        description: textSchema,
        label: textSchema,
    }),
    v.readonly(),
);
const questionSchema = v.pipe(
    v.strictObject({
        header: textSchema,
        multiSelect: v.boolean(),
        options: v.pipe(v.array(optionSchema), v.maxLength(200), v.readonly()),
        question: textSchema,
    }),
    v.readonly(),
);
const requestSchema = v.pipe(
    v.strictObject({
        questions: v.pipe(v.array(questionSchema), v.minLength(1), v.maxLength(100), v.readonly()),
    }),
    v.readonly(),
);

function parseRequest(value: string): v.InferOutput<typeof requestSchema> | null {
    try {
        const decoded: unknown = JSON.parse(value);
        const request = v.safeParse(requestSchema, decoded);
        return request.success ? request.output : null;
    } catch {
        return null;
    }
}

interface ParsedQuotedText {
    readonly end: number;
    readonly value: string;
}

function parseQuotedText(value: string, start: number): ParsedQuotedText | null {
    if (value[start] !== '"') {
        return null;
    }
    for (let index = start + 1; index < value.length; index += 1) {
        if (value[index] === "\\") {
            index += 1;
        } else if (value[index] === '"') {
            try {
                const decoded: unknown = JSON.parse(value.slice(start, index + 1));
                const text = v.safeParse(textSchema, decoded);
                return text.success ? { end: index + 1, value: text.output } : null;
            } catch {
                return null;
            }
        }
    }
    return null;
}

function parseAnswers(output: string): ReadonlyMap<string, string> {
    const prefix = "Your questions have been answered: ";
    const suffix = ". You can now continue with these answers in mind.";
    if (!output.startsWith(prefix) || !output.endsWith(suffix)) {
        return new Map();
    }
    const response = output.slice(prefix.length, -suffix.length);
    const answers = new Map<string, string>();
    let position = 0;
    while (position < response.length) {
        const question = parseQuotedText(response, position);
        if (question === null || response[question.end] !== "=") {
            return new Map();
        }
        const answer = parseQuotedText(response, question.end + 1);
        if (answer === null) {
            return new Map();
        }
        answers.set(question.value, answer.value);
        position = answer.end;
        if (position === response.length) {
            return answers;
        }
        if (!response.startsWith(", ", position)) {
            return new Map();
        }
        position += 2;
    }
    return answers;
}

export function matchesQuestionToolCall({ input }: ToolRendererProps["entry"]): boolean {
    return parseRequest(input) !== null;
}

export function QuestionToolCall({ entry }: ToolRendererProps) {
    const request = parseRequest(entry.input);
    if (request === null) {
        return null;
    }
    const answers = parseAnswers(entry.output);
    return (
        <ToolCallDisclosure
            ariaLabel={`Questions: ${entry.title}`}
            icon={<CircleHelp aria-hidden="true" className="size-4 shrink-0" />}
            state={entry.state}
            title={entry.title}
        >
            <div className="grid min-w-0 gap-4 text-sm">
                {request.questions.map((question, questionIndex) => {
                    const answer = answers.get(question.question);
                    return (
                        <section
                            className="grid gap-2 rounded-lg border border-black/7 bg-black/[0.025] p-3"
                            key={`${question.header}:${questionIndex.toString()}`}
                        >
                            <div className="flex flex-wrap items-baseline justify-between gap-2">
                                <h4 className="font-semibold text-foreground">{question.header}</h4>
                                <span className="text-[11px] text-copy-tertiary">
                                    {question.multiSelect ? "Multiple choices" : "Single choice"}
                                </span>
                            </div>
                            <p className="leading-5 text-copy-secondary">{question.question}</p>
                            <ul className="grid gap-2">
                                {question.options.map((option, optionIndex) => (
                                    <li
                                        className="rounded-md border border-black/7 bg-white/70 px-3 py-2"
                                        key={`${option.label}:${optionIndex.toString()}`}
                                    >
                                        <p className="font-medium text-foreground">{option.label}</p>
                                        {option.description.length > 0 && (
                                            <p className="mt-1 text-xs leading-5 text-copy-secondary">
                                                {option.description}
                                            </p>
                                        )}
                                    </li>
                                ))}
                            </ul>
                            {answer !== undefined && (
                                <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2">
                                    <p className="text-[11px] font-medium text-copy-tertiary">Your answer</p>
                                    <p className="mt-1 leading-5 text-foreground whitespace-pre-wrap">{answer}</p>
                                </div>
                            )}
                        </section>
                    );
                })}
            </div>
        </ToolCallDisclosure>
    );
}
