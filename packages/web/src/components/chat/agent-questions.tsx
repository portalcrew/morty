import type { AgentQuestion } from "@portalcrew/morty-client/protocol";
import { HelpCircle } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/cloud-button";
import type { AgentQuestionChoices } from "@/view-models/chat/agent-question-answer";

/**
 * Questions an Agent message asks while the Agent keeps working. Picking a suggested answer and sending it answers
 * with an ordinary message; a question without suggested answers is answered in the composer.
 */
export function AgentQuestions({
    answerable,
    choices,
    disabled,
    onAnswer,
    onChoose,
    questions,
    ready,
}: {
    readonly answerable: boolean;
    readonly choices: AgentQuestionChoices;
    readonly disabled: boolean;
    readonly onAnswer: () => void;
    readonly onChoose: (questionIndex: number, answer: string) => void;
    readonly questions: readonly AgentQuestion[];
    readonly ready: boolean;
}) {
    const id = useId();
    const locked = !answerable || disabled;
    return (
        <section
            aria-label="Agent question"
            className="my-2 min-w-0 w-full rounded-[20px] border-[0.5px] border-border/50 bg-surface-elevated px-4 py-4 text-13 [overflow-wrap:anywhere]"
        >
            <div className="flex items-start gap-2">
                <HelpCircle aria-hidden="true" className="mt-[3px] size-4 shrink-0 text-muted-foreground" />
                <form
                    className="grid min-w-0 flex-1 gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (ready && !locked) {
                            onAnswer();
                        }
                    }}
                >
                    {questions.map((question, index) => (
                        <fieldset className="grid min-w-0 gap-2" key={`${id}-${index.toString()}`}>
                            <legend className="mb-2 whitespace-pre-wrap text-13 leading-5 text-foreground">
                                {question.question}
                            </legend>
                            {question.options.map((option, optionIndex) => (
                                <label
                                    className="flex min-h-11 cursor-pointer items-center gap-2 rounded-[12px] border-[0.5px] border-border px-3 py-2 text-13 leading-5 text-foreground has-[:checked]:border-foreground has-[:disabled]:cursor-default has-[:disabled]:opacity-60 md:min-h-9"
                                    key={`${id}-${index.toString()}-${optionIndex.toString()}`}
                                >
                                    <input
                                        checked={choices[index.toString()] === option}
                                        className="accent-foreground"
                                        disabled={!answerable}
                                        name={`${id}-${index.toString()}`}
                                        onChange={() => onChoose(index, option)}
                                        type="radio"
                                        value={option}
                                    />
                                    {option}
                                </label>
                            ))}
                        </fieldset>
                    ))}
                    {questions.some((question) => question.options.length > 0) && (
                        <div>
                            <Button
                                className="min-h-11 md:min-h-9"
                                disabled={locked || !ready}
                                size="sm"
                                type="submit"
                                variant="primary"
                            >
                                Send answer
                            </Button>
                        </div>
                    )}
                </form>
            </div>
        </section>
    );
}
