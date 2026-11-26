import { Clock4, CornerUpLeft, LoaderCircle, MessageSquare, Pencil, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { ExplainedUnavailable, type UnavailableExplanation } from "../../components/chat/unavailable-explanation.tsx";
import { ScrollArea } from "../../components/ui/scroll-area.tsx";
import { dataTestId } from "../../data-testid.ts";
import type { SteeringUnavailable } from "../../view-models/chat/session-operation-rules.ts";
import type { sessionPanePresentation } from "../../view-models/chat/session-pane-presentation.ts";

function QueueAction({
    label,
    disabled,
    explanation,
    onClick,
    children,
}: {
    readonly children: ReactNode;
    readonly disabled: boolean;
    readonly explanation?: UnavailableExplanation | undefined;
    readonly label: string;
    readonly onClick: () => void;
}) {
    const className =
        "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-morty-text-3 outline-none transition-colors hover:bg-transparent hover:text-foreground keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:opacity-40";
    if (disabled && explanation !== undefined) {
        return (
            <ExplainedUnavailable explanation={explanation}>
                <button
                    aria-disabled="true"
                    aria-label={label}
                    className={className}
                    title={explanation.title}
                    type="button"
                >
                    {children}
                </button>
            </ExplainedUnavailable>
        );
    }
    return (
        <button
            aria-label={label}
            className={className}
            disabled={disabled}
            onClick={onClick}
            title={label}
            type="button"
        >
            {children}
        </button>
    );
}

export function ChatMessageQueue({
    messages,
    pendingMessages,
    onDelete,
    onEdit,
    onSteer,
    steerExplanation,
}: {
    readonly messages: ReturnType<typeof sessionPanePresentation>["queuedMessages"];
    readonly pendingMessages: ReturnType<typeof sessionPanePresentation>["pendingQueueMessages"];
    readonly onDelete: (commandId: string) => void;
    readonly onEdit: (commandId: string) => void;
    readonly onSteer: (commandId: string) => void;
    readonly steerExplanation: (reason: SteeringUnavailable) => UnavailableExplanation;
}) {
    if (messages.length + pendingMessages.length === 0) {
        return null;
    }
    return (
        <section
            aria-label="Queued messages"
            aria-live="polite"
            className="relative z-[1] mx-auto -mb-5 w-[min(920px,calc(100%-24px))] min-w-0 shrink-0"
        >
            <div className="min-h-14 overflow-hidden rounded-t-lg border-[0.5px] border-border/50 bg-card shadow-[0_2px_8px_0_rgb(0_0_0/4%)] transition-shadow duration-300 ease-in-out hover:shadow-[0_3px_12px_0_rgb(0_0_0/12%)]">
                <div className="flex h-9 min-w-0 items-center gap-2 pr-4 pl-3">
                    <MessageSquare aria-hidden="true" className="size-3.5 shrink-0 text-morty-text-3" />
                    <div className="flex min-w-0 items-center gap-1">
                        <span className="text-13 font-medium text-morty-text-2">Queued messages</span>
                        <span className="text-12 font-normal text-morty-text-3">
                            {(messages.length + pendingMessages.length).toString()}
                        </span>
                    </div>
                </div>
                <div className="overflow-hidden rounded-t-md bg-morty-fill-white">
                    <ScrollArea className="max-h-[152px]" viewportClassName="max-h-[inherit] [&>div]:block!">
                        <ol className="mb-0 flex w-full min-w-0 list-none flex-col gap-0 px-3 pt-1 pb-6">
                            {messages.map((message) => {
                                const pending = message.kind !== "queued";
                                return (
                                    <li
                                        className="-mx-2 flex items-start gap-2 rounded-sm py-1.5 pr-2.5 pl-2 text-morty-text-2 transition-colors hover:bg-morty-fill-opacity-2"
                                        data-testid={dataTestId.queuedMessage}
                                        key={message.commandId}
                                    >
                                        <div className="flex h-[22px] shrink-0 items-center">
                                            {pending ? (
                                                <LoaderCircle
                                                    aria-hidden="true"
                                                    className="size-3.5 shrink-0 animate-spin text-morty-text-3 motion-reduce:animate-none"
                                                />
                                            ) : (
                                                <Clock4
                                                    aria-hidden="true"
                                                    className="size-3.5 shrink-0 text-morty-text-3"
                                                />
                                            )}
                                        </div>
                                        <span
                                            className="min-w-0 flex-1 truncate text-13 leading-[22px] text-foreground"
                                            title={message.summary}
                                        >
                                            {message.summary}
                                        </span>
                                        <div className="flex h-6 shrink-0 items-center gap-0.5">
                                            <QueueAction
                                                disabled={message.editDisabled}
                                                label={message.editLabel}
                                                onClick={() => onEdit(message.commandId)}
                                            >
                                                <Pencil aria-hidden="true" className="size-3.5" />
                                            </QueueAction>
                                            <QueueAction
                                                disabled={message.steerDisabled}
                                                explanation={
                                                    message.steeringUnavailable === null
                                                        ? undefined
                                                        : steerExplanation(message.steeringUnavailable)
                                                }
                                                label={`Steer queued message: ${message.summary}`}
                                                onClick={() => onSteer(message.commandId)}
                                            >
                                                {message.kind === "steering" ? (
                                                    <LoaderCircle
                                                        aria-hidden="true"
                                                        className="size-3.5 animate-spin motion-reduce:animate-none"
                                                    />
                                                ) : (
                                                    <CornerUpLeft aria-hidden="true" className="size-3.5" />
                                                )}
                                            </QueueAction>
                                            <QueueAction
                                                disabled={message.deleteDisabled}
                                                label={`Delete queued message: ${message.summary}`}
                                                onClick={() => onDelete(message.commandId)}
                                            >
                                                {message.kind === "deleting" ? (
                                                    <LoaderCircle
                                                        aria-hidden="true"
                                                        className="size-3.5 animate-spin motion-reduce:animate-none"
                                                    />
                                                ) : (
                                                    <Trash2 aria-hidden="true" className="size-3.5" />
                                                )}
                                            </QueueAction>
                                        </div>
                                    </li>
                                );
                            })}
                            {pendingMessages.map((message) => (
                                <li
                                    key={message.commandId}
                                    className="-mx-2 flex items-start gap-2 rounded-sm py-1.5 pr-2.5 pl-2 text-morty-text-2"
                                >
                                    <LoaderCircle
                                        aria-label={message.status}
                                        className="mt-1 size-3.5 shrink-0 animate-spin text-morty-text-3 motion-reduce:animate-none"
                                    />
                                    <span
                                        className="min-w-0 flex-1 truncate text-13 leading-[22px] text-foreground"
                                        title={message.summary}
                                    >
                                        {message.summary}
                                    </span>
                                </li>
                            ))}
                        </ol>
                    </ScrollArea>
                </div>
            </div>
        </section>
    );
}
