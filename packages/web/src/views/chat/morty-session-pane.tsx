import type { SessionConfigurationSelection } from "@morty-build/client/protocol";
import { Check, CircleAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import { useStore } from "zustand";
import { dataTestId } from "@/data-testid";
import { AgentQuestions } from "../../components/chat/agent-questions.tsx";
import { AgentThinking } from "../../components/chat/agent-thinking.tsx";
import { AuthenticationNotice } from "../../components/chat/authentication-notice.tsx";
import { AutoFocusInput } from "../../components/chat/auto-focus-input.tsx";
import { BotChatComposer } from "../../components/chat/bot-chat-composer.tsx";
import { ChatConfigurationMenu } from "../../components/chat/chat-configuration-menu.tsx";
import {
    chatSessionAgentReplyGroupClassName,
    chatSessionColumnClassName,
    chatSessionExecutionHeaderClassName,
    chatSessionInteractionColumnClassName,
    chatSessionMessageColumnClassName,
    chatSessionMessageItemClassName,
    chatSessionMessageScrollAreaClassName,
    chatSessionMessageViewportClassName,
    chatSessionPaneFillClassName,
} from "../../components/chat/chat-session-layout.ts";
import type { ComposerAttachment } from "../../components/chat/composer-attachment.ts";
import { ComposerNoticeSlot, composerErrorMessage } from "../../components/chat/composer-notice-slot.tsx";
import { ConnectionNotice } from "../../components/chat/connection-notice.tsx";
import { ReadonlyWorkingDirectory, WorkingDirectorySkeleton } from "../../components/chat/cwd-selector.tsx";
import { HarnessMark } from "../../components/chat/harness-mark.tsx";
import { InlineEditFocus } from "../../components/chat/inline-edit-focus.tsx";
import { MessageDeliveryStatus } from "../../components/chat/message-delivery-status.tsx";
import { MobileRenameOverlay } from "../../components/chat/mobile-rename-overlay.tsx";
import { MobileSessionTitlePortal } from "../../components/chat/mobile-session-title-portal.tsx";
import { ResponseCopyButton } from "../../components/chat/response-copy-button.tsx";
import {
    type ElicitationInteractionResponse,
    type PermissionInteractionResponse,
    SessionInteractionCards,
} from "../../components/chat/session-interactions.tsx";
import { SessionLoadFailure } from "../../components/chat/session-load-failure.tsx";
import { SessionWelcomeInChat } from "../../components/chat/session-welcome.tsx";
import { isFileEditToolCall } from "../../components/chat/tools/tool-renderer-registry.tsx";
import { TurnWorkDisclosure } from "../../components/chat/turn-work-disclosure.tsx";
import { UserPromptMessage } from "../../components/chat/user-prompt-message.tsx";
import { OwnerQueueNotice, WorkingIndicator } from "../../components/chat/working-indicator.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { ScrollArea } from "../../components/ui/scroll-area.tsx";
import { DesktopChatLayout } from "../../components/utils/desktop-chat-layout.tsx";
import { FollowLatestScrollArea } from "../../components/utils/follow-latest-scroll-area.tsx";
import { ScrollEdgeFade } from "../../components/utils/scroll-edge-fade.tsx";
import { cn } from "../../lib/utils.ts";
import { type AgentQuestionChoices, agentQuestionAnswer } from "../../view-models/chat/agent-question-answer.ts";
import { agentReplyCopyText, agentReplyMessageGroups } from "../../view-models/chat/agent-reply-copy.ts";
import { authenticationGuidance } from "../../view-models/chat/authentication-guidance.ts";
import type { ChatWorkspace } from "../../view-models/chat/chat-workspace.ts";
import { canAddAttachments } from "../../view-models/chat/composer-attachment-store.ts";
import { sessionExecutionContext } from "../../view-models/chat/execution-context.ts";
import { sessionHarnessSelection } from "../../view-models/chat/native-session-agents.ts";
import { createResponseCopyStore } from "../../view-models/chat/response-copy-store.ts";
import { sessionInteractionPresentation } from "../../view-models/chat/session-interaction-store.ts";
import {
    type SessionPaneModel,
    sessionPanePresentation,
    sessionTitleEdit,
    type TitleEdit,
} from "../../view-models/chat/session-pane-store.ts";
import { sessionExecutionStates } from "../../view-models/chat/session-presentation.ts";
import { sessionProjectionTimeline } from "../../view-models/chat/session-projection.ts";
import {
    agentReplySections,
    hasRunningProcessWork,
    isGeneratingProcessRenderItem,
    type SessionRenderItem,
    sessionRenderGroups,
    sessionRenderItemId,
    sessionRenderItems,
} from "../../view-models/chat/session-render-items.ts";
import { createSessionResourceStore } from "../../view-models/chat/session-resource-store.ts";
import { sessionTitle } from "../../view-models/chat/session-titles-store.ts";
import { reportApplicationError } from "../../view-models/report-error.ts";
import { ChatMessageQueue } from "./chat-message-queue.tsx";
import { FilePreview } from "./file-preview.tsx";
import { MortyAssistantText, MortySessionMessage } from "./morty-session-message.tsx";

/**
 * Vertical spacing class per reply display item: answer text carries no block
 * margin, process groups and notices declare 12px, failure cards 16px. The
 * article is a plain block flow, so adjacent declared margins collapse to the
 * larger value; first and last edges stay clear.
 */
type ReplyItemSpacing = "alert" | "block" | "text";

function replyItemSpacing(item: SessionRenderItem): ReplyItemSpacing {
    if (item.kind === "assistant-text") {
        return "text";
    }
    if (item.kind === "event" && item.message.role === "assistant" && item.message.presentation.kind === "failure") {
        return "alert";
    }
    return "block";
}

const replyItemSpacingMargins: Record<ReplyItemSpacing, { readonly mb: string; readonly mt: string }> = {
    alert: { mb: "mb-4", mt: "mt-4" },
    block: { mb: "mb-3", mt: "mt-3" },
    text: { mb: "", mt: "" },
};

function replyItemMarginClassName(spacing: ReplyItemSpacing, first: boolean, last: boolean): string {
    const margins = replyItemSpacingMargins[spacing];
    return cn(first ? "" : margins.mt, last ? "" : margins.mb);
}

function SessionRenderItemContent({
    active,
    answerChoices,
    item,
    computerName,
    onAnswer,
    onChooseAnswer,
    onRetryUnknownDelivery,
    onRemoveUnknownDelivery,
    openLocalFile,
    pane,
    presentation,
}: {
    readonly active: boolean;
    readonly answerChoices: ReadonlyMap<string, AgentQuestionChoices>;
    readonly item: SessionRenderItem;
    readonly computerName: string;
    readonly onAnswer: (messageId: string) => void;
    readonly onChooseAnswer: (messageId: string, questionIndex: number, answer: string) => void;
    readonly onRemoveUnknownDelivery: () => void;
    readonly onRetryUnknownDelivery: () => void;
    readonly openLocalFile: (path: string) => void;
    readonly pane: SessionPaneModel;
    readonly presentation: Pick<
        ReturnType<typeof sessionPanePresentation>,
        "answerDisabled" | "deliveryUnknownUserMessageId" | "retryUnknownDeliveryDisabled"
    >;
}) {
    if (item.kind === "assistant-text" && item.messageId !== null && item.questions.length > 0) {
        // The message text only restates the questions for readers that cannot show them.
        const messageId = item.messageId;
        const choices = answerChoices.get(messageId) ?? {};
        return (
            <AgentQuestions
                answerable={item.answerable}
                choices={choices}
                disabled={presentation.answerDisabled}
                onAnswer={() => onAnswer(messageId)}
                onChoose={(questionIndex, answer) => onChooseAnswer(messageId, questionIndex, answer)}
                questions={item.questions}
                ready={agentQuestionAnswer(item.questions, choices) !== null}
            />
        );
    }
    if (item.kind === "assistant-text") {
        return (
            <MortyAssistantText
                createResourceStore={createSessionResourceStore}
                openLocalFile={openLocalFile}
                readImage={pane.readResource}
                text={item.text}
                streaming={active}
            />
        );
    }
    if (item.kind === "thinking") {
        return (
            <div data-testid={dataTestId.agentResponse}>
                <AgentThinking
                    active={active}
                    createResourceStore={createSessionResourceStore}
                    entries={item.entries}
                    readImage={pane.readResource}
                />
            </div>
        );
    }
    return (
        <MortySessionMessage
            active={active}
            deliveryUnknownUserMessageId={presentation.deliveryUnknownUserMessageId}
            failureHarness={pane.harness}
            failureComputerName={computerName}
            message={item.message}
            onRemoveUnknownDelivery={onRemoveUnknownDelivery}
            onRetryUnknownDelivery={onRetryUnknownDelivery}
            openLocalFile={openLocalFile}
            readImage={pane.readResource}
            retryUnknownDeliveryDisabled={presentation.retryUnknownDeliveryDisabled}
        />
    );
}

export function SessionMessageListSkeleton() {
    return (
        <div role="status" aria-label="Loading messages" className={chatSessionColumnClassName}>
            <span className="sr-only">Loading messages</span>
            <div aria-hidden="true" className="grid animate-pulse gap-8 motion-reduce:animate-none">
                <div className="ml-auto grid w-full max-w-[68%] justify-items-end gap-2">
                    <div className="h-4 w-2/3 rounded-full bg-muted" />
                    <div className="h-4 w-full rounded-full bg-muted" />
                    <div className="h-4 w-4/5 rounded-full bg-muted" />
                </div>
                <div className="grid w-full max-w-[78%] gap-2">
                    <div className="h-4 w-1/3 rounded-full bg-muted" />
                    <div className="h-4 w-full rounded-full bg-muted" />
                    <div className="h-4 w-5/6 rounded-full bg-muted" />
                    <div className="h-4 w-3/5 rounded-full bg-muted" />
                </div>
            </div>
        </div>
    );
}

function SessionTitleSkeleton({ centered = false }: { readonly centered?: boolean }) {
    return (
        <h2 className={cn("min-w-0 flex-1 text-sm font-semibold", centered && "w-full max-w-full")}>
            <div
                role="status"
                aria-label="Loading conversation title"
                className={cn("max-w-full", centered && "mx-auto flex justify-center")}
            >
                <span className="sr-only">Loading conversation title</span>
                <div
                    aria-hidden="true"
                    className={cn(
                        "w-40 max-w-full animate-pulse rounded-full bg-muted motion-reduce:animate-none",
                        centered ? "h-5" : "h-4",
                    )}
                />
            </div>
        </h2>
    );
}

/** While the phone rename overlay is open, the header keeps stating the committed title. */
const CLOSED_TITLE_EDIT: TitleEdit = { kind: "closed" };

function SessionConversationTitleBar({
    title,
    titleEdit,
    titleLoading,
    centered,
    harness,
    agentLabel,
    onOpenTitleEdit,
    onSetTitleDraft,
    onCancelTitleEdit,
    onConfirmTitleEdit,
}: {
    readonly title: string;
    readonly titleEdit: TitleEdit;
    readonly titleLoading: boolean;
    readonly centered: boolean;
    readonly harness: string;
    readonly agentLabel: string;
    readonly onOpenTitleEdit: () => void;
    readonly onSetTitleDraft: (draft: string) => void;
    readonly onCancelTitleEdit: () => void;
    readonly onConfirmTitleEdit: () => void;
}) {
    const displayTitle = title || "Untitled session";
    const titleTextClassName = centered ? "text-[14px] leading-5" : "text-sm";
    const titleHarnessMark = (loading: boolean) =>
        centered ? null : (
            <HarnessMark
                harness={harness || agentLabel}
                className="text-copy-secondary"
                label={agentLabel}
                loading={loading}
                testId={dataTestId.sessionTitleHarnessMark}
            />
        );
    const saving = titleEdit.kind === "saving";
    const closedTitle = (ref: (node: HTMLElement | null) => void) => {
        if (titleLoading) {
            return (
                <h2
                    className={cn(
                        "flex min-w-0 items-center font-semibold",
                        titleTextClassName,
                        centered ? "w-full max-w-full justify-center gap-1" : "gap-2.5",
                    )}
                >
                    {titleHarnessMark(true)}
                    <div aria-label="Loading conversation title" className="min-w-0 max-w-full" role="status">
                        <span className="sr-only">Loading conversation title</span>
                        <div
                            aria-hidden="true"
                            className={cn(
                                "max-w-full animate-pulse rounded-full bg-muted motion-reduce:animate-none",
                                centered ? "h-5 w-28" : "h-4 w-40",
                            )}
                        />
                    </div>
                </h2>
            );
        }
        return (
            <h2
                className={cn(
                    "flex min-w-0 items-center font-semibold",
                    titleTextClassName,
                    centered ? "w-full max-w-full justify-center gap-1" : "gap-2.5",
                )}
                title={displayTitle}
            >
                {titleHarnessMark(false)}
                <button
                    type="button"
                    aria-label={displayTitle}
                    className={cn(
                        "min-w-0 max-w-full cursor-pointer truncate outline-none hover:text-primary keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/70",
                        centered ? "text-center" : "text-left",
                    )}
                    title="Rename conversation"
                    onClick={onOpenTitleEdit}
                    ref={ref}
                >
                    {displayTitle}
                </button>
            </h2>
        );
    };
    return (
        <InlineEditFocus
            control={closedTitle}
            editing={titleEdit.kind !== "closed" && titleEdit.kind !== "failed"}
            editor={
                <>
                    {titleHarnessMark(false)}
                    <AutoFocusInput
                        aria-label="Conversation title"
                        className={cn(
                            "appearance-none rounded-none border-0 bg-transparent px-0 py-0 font-semibold shadow-none outline-none ring-0 keyboard-focus:focus:ring-0 keyboard-focus:focus-visible:ring-0",
                            titleTextClassName,
                            centered ? "w-[10rem] min-w-[8rem] shrink text-center" : "min-w-0 flex-1",
                        )}
                        disabled={saving}
                        maxLength={500}
                        value={
                            titleEdit.kind === "closed" || titleEdit.kind === "failed" ? displayTitle : titleEdit.draft
                        }
                        onChange={(event) => onSetTitleDraft(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                event.preventDefault();
                                onConfirmTitleEdit();
                            }
                            if (event.key === "Escape") {
                                onCancelTitleEdit();
                            }
                        }}
                    />
                    <div className="flex shrink-0 items-center gap-1">
                        <Button
                            aria-label="Cancel rename"
                            disabled={saving}
                            size="icon"
                            variant="ghost"
                            onClick={onCancelTitleEdit}
                        >
                            <X className="size-4" />
                        </Button>
                        <Button
                            aria-label="Save title"
                            disabled={saving}
                            size="icon"
                            variant="ghost"
                            onClick={onConfirmTitleEdit}
                        >
                            <Check className="size-4" />
                        </Button>
                    </div>
                </>
            }
            editorClassName={cn(
                "flex items-center",
                centered ? "w-max min-w-[14rem] max-w-[70vw] justify-center gap-1" : "min-w-0 flex-1 gap-2.5",
            )}
            label="Rename conversation"
        />
    );
}

/**
 * The conversation is being opened. Its title and messages arrive from the same
 * read, so both stand in as skeletons: a title shown here would appear and then
 * be withdrawn again while the loaded pane waits for that read.
 */
export function MortySessionPaneLoading({ footer }: { readonly footer?: ReactNode }) {
    return (
        <DesktopChatLayout>
            {(desktop) => (
                <>
                    <section className={chatSessionPaneFillClassName}>
                        <header
                            className={cn(chatSessionExecutionHeaderClassName, desktop ? "flex" : "hidden sm:flex")}
                        >
                            <SessionTitleSkeleton />
                            <WorkingDirectorySkeleton />
                        </header>
                        <ScrollArea
                            className={chatSessionMessageScrollAreaClassName}
                            viewportClassName={`h-full ${chatSessionMessageViewportClassName}`}
                            viewportLabel="Messages"
                            viewportRole="log"
                        >
                            <SessionMessageListSkeleton />
                        </ScrollArea>
                        {footer}
                    </section>
                    {desktop ? null : (
                        <MobileSessionTitlePortal>
                            <SessionTitleSkeleton centered />
                        </MobileSessionTitlePortal>
                    )}
                </>
            )}
        </DesktopChatLayout>
    );
}

/**
 * Shows a recovered submission whose delivery was never confirmed. The service
 * does not hold this message, so no projected user message carries the retry
 * and remove controls; the journal's own prompt stands in for it until the
 * service confirms the turn.
 */
function UnconfirmedDeliveryCard({
    delivery,
    retryDisabled,
    onRemove,
    onRetry,
}: {
    readonly delivery: {
        readonly commandId: string;
        readonly displayPrompt: string;
        readonly attachmentLabels: readonly { readonly name: string; readonly uri: string }[];
        readonly attachments: readonly ComposerAttachment[];
    };
    readonly retryDisabled: boolean;
    readonly onRemove: () => void;
    readonly onRetry: () => void;
}) {
    return (
        <div className={chatSessionMessageItemClassName}>
            <UserPromptMessage
                attachments={delivery.attachments}
                attachmentLabels={delivery.attachmentLabels}
                text={delivery.displayPrompt}
            />
            <div
                className="ml-auto flex max-w-[85%] items-center gap-3 rounded-lg border border-destructive/15 bg-destructive/5 py-2 pr-2 pl-3 text-xs leading-5 text-destructive"
                role="alert"
            >
                <button
                    aria-label="Retry message with unknown delivery"
                    className="inline-flex size-7 items-center justify-center rounded-full"
                    disabled={retryDisabled}
                    onClick={onRetry}
                    type="button"
                >
                    <CircleAlert aria-hidden="true" className="size-4.5" />
                </button>
                <span className="min-w-0 flex-1">
                    Delivery wasn’t confirmed. This message won’t be sent again unless you retry it.
                </span>
                <button aria-label="Remove failed message" onClick={onRemove} type="button">
                    <X aria-hidden="true" className="size-4" />
                </button>
            </div>
        </div>
    );
}

/**
 * Stands in for older messages while an earlier history page is fetched above
 * the visible list. It carries no text of its own so the placeholder reads as
 * content rather than as a status label.
 */
function OlderHistorySkeleton() {
    return (
        <div aria-label="Loading older messages" className={`${chatSessionColumnClassName} mb-8`} role="status">
            <div aria-hidden="true" className="grid animate-pulse gap-8 motion-reduce:animate-none">
                <div className="ml-auto grid w-full max-w-[68%] justify-items-end gap-2">
                    <div className="h-4 w-2/3 rounded-full bg-muted" />
                    <div className="h-4 w-4/5 rounded-full bg-muted" />
                </div>
                <div className="grid w-full max-w-[78%] gap-2">
                    <div className="h-4 w-2/5 rounded-full bg-muted" />
                    <div className="h-4 w-full rounded-full bg-muted" />
                </div>
            </div>
        </div>
    );
}

export function MortySessionPane({ workspace }: { readonly workspace: ChatWorkspace }) {
    // The workspace owns the pane outside React; the view follows it and hands its model to the pane body, which
    // subscribes to its stores.
    const pane = useStore(workspace.pane);
    if (pane.kind === "none") {
        return <section className={chatSessionPaneFillClassName} />;
    }
    return <MortySessionPaneBody pane={pane.model} workspace={workspace} />;
}

function MortySessionPaneBody({
    pane,
    workspace,
}: {
    readonly pane: SessionPaneModel;
    readonly workspace: ChatWorkspace;
}) {
    const home = useStore(workspace.home);
    const computer = useStore(workspace.computer);
    const computerConfiguration = computer.computerConfiguration;
    const model = useStore(pane.store);
    const composer = useStore(pane.composer);
    const timeline = sessionProjectionTimeline(model.projection);
    const rename = useStore(pane.rename);
    const titleEdit = sessionTitleEdit(composer.titleDraft, rename.rename);
    const title = useStore(workspace.titles, (state) => sessionTitle(state.titles, pane.session.result.ready.target));
    const attachmentModel = useStore(pane.composerAttachments);
    const execution = useStore(pane.execution, (state) => state.state);
    const interactionModel = useStore(pane.interactions);
    const settingsModel = useStore(pane.settings);
    const interactions = sessionInteractionPresentation(interactionModel, execution.interactions, timeline.messages);
    const preview = useStore(pane.filePreview);
    const delivery = useStore(pane.delivery);
    const messageQueue = useStore(pane.messageQueue);
    const taskControls = useStore(pane.tasks);
    const welcome = useStore(pane.welcome, (state) => state.state);
    const harness = sessionHarnessSelection(computerConfiguration?.computer ?? null, pane.harness);

    const run = (action: (signal: AbortSignal) => Promise<void>) => {
        const signal = pane.operationsSignal();
        void action(signal).catch((cause: unknown) => {
            if (!signal.aborted) {
                reportApplicationError(cause, "session-pane-action");
            }
        });
    };
    const runAndFollow = (action: (signal: AbortSignal) => Promise<void>) => {
        run(action);
    };
    const respondToPermission = (response: PermissionInteractionResponse): void => {
        interactionModel.respondToPermission(response, pane.operationsSignal());
    };
    const respondToElicitation = (response: ElicitationInteractionResponse): void => {
        interactionModel.respondToElicitation(response, pane.operationsSignal());
    };
    const executionContext = sessionExecutionContext(pane.session, home, computer, model.connection);
    const presentation = sessionPanePresentation(
        model,
        execution,
        composer,
        rename,
        delivery,
        taskControls,
        messageQueue,
        attachmentModel,
        settingsModel,
        executionContext.available,
    );
    // An answer to an Agent's question goes out as the composer's message would, which the Computer runs or queues.
    const answer = (messageId: string): void =>
        runAndFollow(async () => {
            await pane.store.getState().sendAnswer(messageId);
        });
    // The composer notice floats over the log only while nothing stands between
    // the log and the composer. With a queue or interaction card present it joins
    // the flow instead, so it can never cover their actions or be lifted past the
    // pane's clipped top edge. Derived from the same state that renders them.
    const noticePlacement =
        presentation.queuedMessages.length +
            presentation.pendingQueueMessages.length +
            interactions.permissions.length +
            interactions.elicitations.length >
        0
            ? ("in-flow" as const)
            : ("overlay" as const);
    const authenticationRecovery =
        presentation.authenticationFailure === null
            ? null
            : authenticationGuidance(presentation.authenticationFailure.code, pane.harness, executionContext.computer);
    // The notice slot's three inputs, shared by the pane-level in-flow slot and the
    // composer's overlay slot so both placements render the very same card.
    const slotConnectionNotice =
        executionContext.feedback.kind === "hidden"
            ? undefined
            : (inline: boolean) => (
                  <ConnectionNotice
                      feedback={executionContext.feedback}
                      inline={inline}
                      onRetryNow={pane.store.getState().retryNow}
                  />
              );
    const slotErrorMessage = composerErrorMessage(presentation.composerError, attachmentModel.state);
    const slotStatusMessage =
        executionContext.feedback.kind === "hidden" && composer.filesRestoreNotice
            ? "Files attached to this message could not be restored here. Add them again if it had any."
            : undefined;
    // Mirrors the slot's own visibility rule: when the notice heads the stack, the
    // interaction card drops its top margin so the slot's 8px is the whole gap.
    const stackNoticeVisible =
        slotErrorMessage.length > 0 || slotConnectionNotice !== undefined || slotStatusMessage !== undefined;
    const renderItems = sessionRenderItems(timeline.messages);
    const renderGroups = sessionRenderGroups(renderItems);
    const executionStates = sessionExecutionStates(timeline.messages, presentation.activity.kind === "working");
    const executionStateByItemId = new Map(
        timeline.messages.flatMap((message, index) => {
            const state = executionStates[index];
            return state === undefined ? [] : [[message.firstEvent.eventId, state] as const];
        }),
    );
    const replyMessagesByRenderGroupId = new Map(
        agentReplyMessageGroups(timeline.messages).map((group) => [group.id, group.messages] as const),
    );
    const lastRenderItemIndex = renderItems.length - 1;
    const generationActive = presentation.workingIndicator !== null && presentation.activity.kind === "working";
    const sessionMessagesLoading =
        model.connection.kind === "first-loading" &&
        timeline.messages.length === 0 &&
        presentation.awaitingMessage === null;
    const initialMessage = presentation.awaitingMessage;
    const configure = (selection: SessionConfigurationSelection) =>
        run(async (signal) => await pane.store.getState().configure(selection, signal));
    const openLocalFile = (path: string) => {
        void pane.filePreview.getState().open(path, pane.operationsSignal());
    };
    const reloadLocalFile = () => {
        void pane.filePreview.getState().reload(pane.operationsSignal());
    };
    const openMarkdownLink = (path: string) => {
        void pane.filePreview.getState().openMarkdownLink(path, pane.operationsSignal());
    };

    const workingDirectoryLabel = executionContext.directory ?? executionContext.directoryPlaceholder;
    const titleBarProps = {
        title,
        titleEdit,
        titleLoading: sessionMessagesLoading,
        harness: executionContext.harness,
        agentLabel: executionContext.agent,
        onOpenTitleEdit: () => pane.store.getState().openTitleEdit(),
        onSetTitleDraft: (draft: string) => pane.store.getState().setTitleDraft(draft),
        onCancelTitleEdit: () => pane.store.getState().cancelTitleEdit(),
        onConfirmTitleEdit: () => run(async (signal) => await pane.store.getState().confirmTitleEdit(signal)),
    };

    return (
        <DesktopChatLayout>
            {(desktop) => (
                <>
                    <section className={chatSessionPaneFillClassName}>
                        {desktop ? (
                            <header className={chatSessionExecutionHeaderClassName}>
                                <div className="min-w-0 flex-1">
                                    <SessionConversationTitleBar {...titleBarProps} centered={false} />
                                </div>
                                {sessionMessagesLoading ? (
                                    <WorkingDirectorySkeleton />
                                ) : (
                                    <ReadonlyWorkingDirectory
                                        className="shrink-0"
                                        directoryLabel={workingDirectoryLabel}
                                        iconClassName="size-3"
                                        tooltipSide="bottom"
                                    />
                                )}
                            </header>
                        ) : null}
                        <FollowLatestScrollArea
                            role="log"
                            followThreshold={80}
                            followRevision={model.followRevision}
                            jumpToLatest={{
                                label: "Jump to latest message",
                                working: presentation.workingIndicator !== null,
                            }}
                            showTopFade
                            aria-label="Messages"
                            className={chatSessionMessageScrollAreaClassName}
                            useProductScrollbar
                            viewportClassName={chatSessionMessageViewportClassName}
                            loadOlder={{
                                hasMore: timeline.hasOlderHistory,
                                loading: presentation.historyLoading,
                                onLoadMore: (signal) => pane.store.getState().loadOlderMessages(signal),
                                revision: timeline.revision,
                            }}
                        >
                            {sessionMessagesLoading && <SessionMessageListSkeleton />}
                            {!sessionMessagesLoading &&
                                timeline.messages.length === 0 &&
                                model.connection.kind === "failed" && (
                                    <div
                                        className={`${chatSessionMessageColumnClassName} flex min-h-full items-center justify-center`}
                                    >
                                        <div className="grid w-full max-w-lg justify-items-center gap-4 text-center">
                                            <SessionLoadFailure message={model.connection.message} />
                                            <Button onClick={() => pane.store.getState().retryNow()} variant="outline">
                                                Reconnect
                                            </Button>
                                        </div>
                                    </div>
                                )}
                            {!sessionMessagesLoading &&
                                initialMessage === null &&
                                presentation.confirmedMessages.length === 0 &&
                                timeline.messages.length === 0 &&
                                model.connection.kind === "ready" &&
                                presentation.activity.kind === "idle" &&
                                !presentation.historyLoading && (
                                    <div className={chatSessionMessageColumnClassName}>
                                        <p className="text-center text-sm text-muted-foreground" role="status">
                                            No message history is available for this session.
                                        </p>
                                    </div>
                                )}
                            {!sessionMessagesLoading && presentation.historyLoading && <OlderHistorySkeleton />}
                            {!sessionMessagesLoading && (
                                <div className={chatSessionMessageColumnClassName}>
                                    {initialMessage !== null && (
                                        <div className={chatSessionMessageItemClassName}>
                                            <UserPromptMessage
                                                attachments={initialMessage.attachments}
                                                text={initialMessage.content}
                                            />
                                        </div>
                                    )}
                                    {(() => {
                                        let flatIndex = 0;
                                        return renderGroups.map((group, groupIndex) => {
                                            if (group.kind === "user") {
                                                const followsUserMessage =
                                                    groupIndex === 0
                                                        ? initialMessage !== null
                                                        : renderGroups[groupIndex - 1]?.kind === "user";
                                                const active = generationActive && flatIndex === lastRenderItemIndex;
                                                const item = group.item;
                                                flatIndex += 1;
                                                return (
                                                    <div
                                                        key={group.id}
                                                        className={cn(
                                                            chatSessionMessageItemClassName,
                                                            // The previous bubble already reserves its 32px
                                                            // copy-button strip; mt-1 keeps the former 36px
                                                            // bubble-to-bubble total.
                                                            followsUserMessage && "mt-1",
                                                        )}
                                                    >
                                                        <SessionRenderItemContent
                                                            active={active}
                                                            answerChoices={composer.answerChoices}
                                                            item={item}
                                                            computerName={executionContext.computer}
                                                            onAnswer={answer}
                                                            onChooseAnswer={pane.store.getState().chooseAnswer}
                                                            onRemoveUnknownDelivery={
                                                                pane.store.getState().removeUnknownDelivery
                                                            }
                                                            onRetryUnknownDelivery={() =>
                                                                run(pane.store.getState().retryUnknownDelivery)
                                                            }
                                                            openLocalFile={openLocalFile}
                                                            pane={pane}
                                                            presentation={presentation}
                                                        />
                                                    </div>
                                                );
                                            }
                                            const firstIndex = flatIndex;
                                            flatIndex += group.items.length;
                                            const replyActive = generationActive && flatIndex > lastRenderItemIndex;
                                            const isRenderItemActive = (item: SessionRenderItem) =>
                                                replyActive &&
                                                firstIndex + group.items.indexOf(item) === lastRenderItemIndex;
                                            const renderItem = (item: SessionRenderItem, spacingClassName: string) => {
                                                const active = isRenderItemActive(item);
                                                return (
                                                    <div className={spacingClassName} key={sessionRenderItemId(item)}>
                                                        <SessionRenderItemContent
                                                            active={active}
                                                            answerChoices={composer.answerChoices}
                                                            item={item}
                                                            computerName={executionContext.computer}
                                                            onAnswer={answer}
                                                            onChooseAnswer={pane.store.getState().chooseAnswer}
                                                            onRemoveUnknownDelivery={
                                                                pane.store.getState().removeUnknownDelivery
                                                            }
                                                            onRetryUnknownDelivery={() =>
                                                                run(pane.store.getState().retryUnknownDelivery)
                                                            }
                                                            openLocalFile={openLocalFile}
                                                            pane={pane}
                                                            presentation={presentation}
                                                        />
                                                    </div>
                                                );
                                            };
                                            const execution = executionStateByItemId.get(group.id) ?? { kind: "open" };
                                            const sections = agentReplySections(group.items, isFileEditToolCall);
                                            // A generation the Agent drives natively reports no Morty turn; its running
                                            // tools are the only live signal that it is still working.
                                            const replyGenerating = replyActive || hasRunningProcessWork(group.items);
                                            const copyText = agentReplyCopyText(
                                                replyMessagesByRenderGroupId.get(group.id) ?? [],
                                                execution,
                                                replyGenerating,
                                            );
                                            // Flatten the article children so positional margin clearing sees the
                                            // laid-out order, including the trailing copy action row. Items inside a
                                            // process disclosure clear first/last within the disclosure body instead.
                                            const replyChildren: {
                                                readonly key: string;
                                                readonly render: (spacingClassName: string) => ReactNode;
                                                readonly spacing: ReplyItemSpacing;
                                            }[] = [];
                                            sections.forEach((section, sectionIndex) => {
                                                if (section.kind === "process") {
                                                    replyChildren.push({
                                                        key: section.id,
                                                        render: (spacingClassName) => (
                                                            <TurnWorkDisclosure
                                                                className={spacingClassName}
                                                                key={section.id}
                                                                summary={section.summary}
                                                                working={
                                                                    replyActive &&
                                                                    sectionIndex === sections.length - 1 &&
                                                                    section.items.some(isGeneratingProcessRenderItem)
                                                                }
                                                            >
                                                                {section.items.map((item, index) =>
                                                                    renderItem(
                                                                        item,
                                                                        replyItemMarginClassName(
                                                                            replyItemSpacing(item),
                                                                            index === 0,
                                                                            index === section.items.length - 1,
                                                                        ),
                                                                    ),
                                                                )}
                                                            </TurnWorkDisclosure>
                                                        ),
                                                        spacing: "block",
                                                    });
                                                    return;
                                                }
                                                for (const item of section.items) {
                                                    replyChildren.push({
                                                        key: sessionRenderItemId(item),
                                                        render: (spacingClassName) =>
                                                            renderItem(item, spacingClassName),
                                                        spacing: replyItemSpacing(item),
                                                    });
                                                }
                                            });
                                            const replyChildCount = replyChildren.length + (copyText === null ? 0 : 1);
                                            return (
                                                <article
                                                    key={group.id}
                                                    aria-label="Agent response"
                                                    className={cn(
                                                        chatSessionAgentReplyGroupClassName,
                                                        replyActive && "pb-3",
                                                    )}
                                                >
                                                    {replyChildren.map((child, index) =>
                                                        child.render(
                                                            replyItemMarginClassName(
                                                                child.spacing,
                                                                index === 0,
                                                                index === replyChildCount - 1,
                                                            ),
                                                        ),
                                                    )}
                                                    {copyText !== null && (
                                                        <ResponseCopyButton
                                                            createStore={createResponseCopyStore}
                                                            text={copyText}
                                                        />
                                                    )}
                                                </article>
                                            );
                                        });
                                    })()}
                                    {presentation.confirmedMessages.map((message) => (
                                        <div key={message.commandId} className={chatSessionMessageItemClassName}>
                                            <UserPromptMessage
                                                attachments={message.attachments}
                                                attachmentLabels={message.attachmentLabels}
                                                text={message.content}
                                            />
                                        </div>
                                    ))}
                                    {presentation.pendingDelivery !== null && (
                                        <div
                                            className={chatSessionMessageItemClassName}
                                            data-testid={dataTestId.queuedMessage}
                                        >
                                            <UserPromptMessage
                                                attachments={presentation.pendingDelivery.message.attachments}
                                                attachmentLabels={presentation.pendingDelivery.message.attachmentLabels}
                                                status={
                                                    presentation.pendingDelivery.error !== null ? (
                                                        <MessageDeliveryStatus
                                                            delivery="failed"
                                                            label="Message failed to send"
                                                        />
                                                    ) : presentation.pendingDelivery.sending ? (
                                                        <MessageDeliveryStatus
                                                            delivery="sending"
                                                            label="Sending message"
                                                        />
                                                    ) : undefined
                                                }
                                                text={presentation.pendingDelivery.message.content}
                                            />
                                            {presentation.pendingDelivery.error !== null && (
                                                <div
                                                    className="ml-auto flex max-w-[85%] items-center gap-3 text-xs text-destructive"
                                                    role="alert"
                                                >
                                                    <span>{presentation.pendingDelivery.error}</span>
                                                    <Button
                                                        disabled={presentation.retryFailedDisabled}
                                                        onClick={() => run(pane.store.getState().retryFailedMessage)}
                                                    >
                                                        Retry message
                                                    </Button>
                                                    <Button
                                                        disabled={attachmentModel.state.kind === "reading"}
                                                        onClick={pane.store.getState().editFailedMessage}
                                                    >
                                                        Edit failed message
                                                    </Button>
                                                    <Button onClick={pane.store.getState().discardFailedMessage}>
                                                        Discard failed message
                                                    </Button>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                    {presentation.unconfirmedDelivery !== null && (
                                        <UnconfirmedDeliveryCard
                                            delivery={presentation.unconfirmedDelivery}
                                            retryDisabled={presentation.retryUnknownDeliveryDisabled}
                                            onRemove={() => pane.store.getState().removeUnknownDelivery()}
                                            onRetry={() => run(pane.store.getState().retryUnknownDelivery)}
                                        />
                                    )}
                                    {presentation.workingIndicator !== null &&
                                        presentation.outputState !== "idle" &&
                                        presentation.activity.kind === "working" && (
                                            // mt-1 keeps 4px of air under the previous bubble's reserved
                                            // copy-button strip, matching the consecutive-message rhythm.
                                            <div className="mt-1">
                                                {presentation.workingIndicator.kind === "queued-in-owner" ? (
                                                    <OwnerQueueNotice owner={executionContext.agent} />
                                                ) : (
                                                    <WorkingIndicator
                                                        owner={
                                                            presentation.workingIndicator.inOwner
                                                                ? executionContext.agent
                                                                : null
                                                        }
                                                        startedAt={presentation.workingIndicator.startedAt}
                                                    />
                                                )}
                                            </div>
                                        )}
                                    {authenticationRecovery !== null && presentation.authenticationFailure !== null && (
                                        <div className={chatSessionMessageItemClassName}>
                                            <AuthenticationNotice
                                                code={presentation.authenticationFailure.code}
                                                guidance={authenticationRecovery}
                                                message={presentation.authenticationFailure.message}
                                            />
                                        </div>
                                    )}
                                    {model.connection.kind === "ready" && (
                                        <SessionWelcomeInChat
                                            canSuggestProgress={presentation.canSuggestProgress}
                                            onDismiss={pane.welcome.getState().dismiss}
                                            onSuggestProgress={pane.welcome.getState().suggestProgress}
                                            visible={welcome.kind === "visible"}
                                        />
                                    )}
                                </div>
                            )}
                        </FollowLatestScrollArea>
                        {noticePlacement === "in-flow" && (
                            <ComposerNoticeSlot
                                connectionNotice={slotConnectionNotice}
                                errorMessage={slotErrorMessage}
                                placement="in-flow"
                                statusMessage={slotStatusMessage}
                            />
                        )}
                        {(interactions.elicitations.length > 0 || interactions.permissions.length > 0) && (
                            <ScrollEdgeFade
                                fadeFromClassName="from-card"
                                fadeToClassName="to-card/0"
                                // The card yields the height the header and composer need: it shrinks inside
                                // the clipped pane and keeps scrolling its own content instead of pushing
                                // the composer below the pane's bottom edge. Only when an in-flow notice
                                // stacks above the composer as well does a floor keep its first row reachable;
                                // otherwise the card yields all the way so the composer stays whole.
                                frameClassName={`${chatSessionInteractionColumnClassName} ${stackNoticeVisible ? "mb-2 min-h-24" : "mt-4 mb-2 sm:mt-5"} flex shrink flex-col`}
                                className="max-h-[min(50vh,360px)] min-h-0 flex-1"
                                viewportLabel="Pending Agent requests"
                            >
                                <SessionInteractionCards
                                    answerDrafts={interactions.answerDrafts}
                                    elicitations={interactions.elicitations}
                                    onElicitationAnswer={(interactionId, fieldName, value) =>
                                        interactionModel.editAnswer(interactionId, fieldName, value)
                                    }
                                    fileChanges={interactions.fileChanges}
                                    permissions={interactions.permissions}
                                    busyInteractionIds={interactions.busyInteractionIds}
                                    error={interactions.error}
                                    onElicitationResponse={respondToElicitation}
                                    onPermissionResponse={respondToPermission}
                                    onStop={() => run(pane.store.getState().stop)}
                                />
                            </ScrollEdgeFade>
                        )}
                        <ChatMessageQueue
                            messages={presentation.queuedMessages}
                            pendingMessages={presentation.pendingQueueMessages}
                            steeringSupported={pane.steeringSupported}
                            onDelete={(commandId) =>
                                run(async (signal) => await pane.store.getState().deleteQueued(commandId, signal))
                            }
                            onEdit={(commandId) =>
                                run(async (signal) => await pane.store.getState().editQueued(commandId, signal))
                            }
                            onSteer={(commandId) =>
                                runAndFollow(
                                    async (signal) => await pane.store.getState().steerQueued(commandId, signal),
                                )
                            }
                        />
                        <BotChatComposer
                            attachmentModel={attachmentModel}
                            focusScope={workspace}
                            canAttach={canAddAttachments(attachmentModel)}
                            attachmentSignal={pane.attachmentSignal}
                            disabled={presentation.composerInputDisabled}
                            draft={composer.draft}
                            error={slotErrorMessage}
                            connectionNotice={slotConnectionNotice}
                            statusMessage={slotStatusMessage}
                            noticePlacement={noticePlacement}
                            onDraftChange={pane.store.getState().setDraft}
                            onStop={() => run(pane.store.getState().stop)}
                            onSubmit={() => runAndFollow(pane.store.getState().send)}
                            outputState={presentation.outputState}
                            stopDisabled={presentation.stopDisabled}
                            submitDisabled={presentation.submitDisabled}
                        >
                            <ChatConfigurationMenu
                                notice={
                                    presentation.settingsNotice === null ? undefined : (
                                        <div className="px-5 pb-3 text-xs leading-5 text-copy-secondary" role="note">
                                            <p>{presentation.settingsNotice}</p>
                                            <button
                                                className="mt-1 rounded-sm text-foreground underline underline-offset-4 outline-none keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/50 disabled:opacity-50"
                                                disabled={presentation.settingsStopDisabled}
                                                onClick={() => run(pane.store.getState().stop)}
                                                type="button"
                                            >
                                                Stop current response
                                            </button>
                                        </div>
                                    )
                                }
                                controls={[
                                    {
                                        disabled: true,
                                        id: "harness",
                                        kind: "select" as const,
                                        label: "Harness",
                                        locked: true,
                                        onValueChange: () => {},
                                        options: harness.options,
                                        value: harness.value,
                                    },
                                    ...settingsModel.options.map((option) =>
                                        option.type === "boolean"
                                            ? {
                                                  checked: option.booleanValue,
                                                  disabled: presentation.settingsDisabled,
                                                  id: option.id,
                                                  kind: "boolean" as const,
                                                  label: option.name,
                                                  onCheckedChange: () =>
                                                      configure({
                                                          booleanValue: !option.booleanValue,
                                                          configId: option.id,
                                                          type: "boolean",
                                                      }),
                                                  testId: dataTestId.agentSetting(option.id),
                                              }
                                            : {
                                                  disabled: presentation.settingsDisabled,
                                                  id: option.id,
                                                  kind: "select" as const,
                                                  label: option.name,
                                                  onValueChange: (value: string) =>
                                                      configure({ configId: option.id, type: "select", value }),
                                                  options: option.values.map((value) => ({
                                                      value: value.value,
                                                      label: value.name,
                                                  })),
                                                  searchable: option.category === "model",
                                                  testId: dataTestId.agentSetting(option.id),
                                                  value: option.currentValue,
                                              },
                                    ),
                                ]}
                                {...(settingsModel.change.kind === "configuring"
                                    ? { loadingControlId: settingsModel.change.configId }
                                    : {})}
                            />
                            {settingsModel.change.kind === "configuring" && (
                                <span role="status" className="sr-only">
                                    Updating agent settings…
                                </span>
                            )}
                        </BotChatComposer>
                    </section>
                    {desktop ? null : (
                        <>
                            {titleEdit.kind === "editing" || titleEdit.kind === "saving" ? (
                                <MobileRenameOverlay
                                    draft={titleEdit.draft}
                                    saving={titleEdit.kind === "saving"}
                                    onSetTitleDraft={titleBarProps.onSetTitleDraft}
                                    onCancelTitleEdit={titleBarProps.onCancelTitleEdit}
                                    onConfirmTitleEdit={titleBarProps.onConfirmTitleEdit}
                                />
                            ) : null}
                            <MobileSessionTitlePortal>
                                <div className="flex min-w-0 w-full flex-col items-center">
                                    <SessionConversationTitleBar
                                        {...(titleEdit.kind === "editing" || titleEdit.kind === "saving"
                                            ? { ...titleBarProps, titleEdit: CLOSED_TITLE_EDIT }
                                            : titleBarProps)}
                                        centered
                                    />
                                    {sessionMessagesLoading ? (
                                        <WorkingDirectorySkeleton className="mt-0.5 h-5 max-w-full" />
                                    ) : (
                                        <ReadonlyWorkingDirectory
                                            className="-mb-1.5 min-h-0 max-w-full gap-1 px-1 py-0 text-[11px] font-normal text-morty-text-3"
                                            clip="end"
                                            directoryLabel={workingDirectoryLabel}
                                            iconClassName="size-3"
                                            tooltipSide="bottom"
                                        />
                                    )}
                                </div>
                            </MobileSessionTitlePortal>
                        </>
                    )}
                    <FilePreview
                        onClose={preview.close}
                        layout={preview.layout}
                        onPanelAttach={preview.onPanelAttach}
                        onToggleExpanded={preview.toggleExpanded}
                        onHtmlAttach={preview.onHtmlAttach}
                        onView={preview.showView}
                        onMarkdownLink={openMarkdownLink}
                        readMarkdownImage={preview.readMarkdownImage}
                        onReload={reloadLocalFile}
                        state={preview.state}
                    />
                </>
            )}
        </DesktopChatLayout>
    );
}
