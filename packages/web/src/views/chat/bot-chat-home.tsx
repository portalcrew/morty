import { nativeSessionKey } from "@morty-build/client/native-session";
import type { ReactNode } from "react";
import { useStore } from "zustand";
import { MortyLogoMark } from "../../components/brand/morty-logo.tsx";
import { BotChatComposer } from "../../components/chat/bot-chat-composer.tsx";
import {
    chatSessionColumnClassName,
    chatSessionExecutionHeaderClassName,
    chatSessionMessageScrollAreaClassName,
    chatSessionMessageViewportClassName,
    chatSessionPaneEnterClassName,
    chatSessionPaneSectionClassName,
} from "../../components/chat/chat-session-layout.ts";
import { ComputerOfflineIcon } from "../../components/chat/computer-offline-icon.tsx";
import { ConnectionNotice } from "../../components/chat/connection-notice.tsx";
import { CwdSelector } from "../../components/chat/cwd-selector.tsx";
import { HarnessMark } from "../../components/chat/harness-mark.tsx";
import { MessageDeliveryStatus } from "../../components/chat/message-delivery-status.tsx";
import { MobileSessionTitlePortal } from "../../components/chat/mobile-session-title-portal.tsx";
import { SessionLoadFailure } from "../../components/chat/session-load-failure.tsx";
import { UserPromptMessage } from "../../components/chat/user-prompt-message.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { DesktopChatLayout } from "../../components/utils/desktop-chat-layout.tsx";
import { FollowLatestScrollArea } from "../../components/utils/follow-latest-scroll-area.tsx";
import { dataTestId } from "../../data-testid.ts";
import { cn } from "../../lib/utils.ts";
import type { DaemonDiagnosticsSource } from "../../services/diagnostics/browser-diagnostics.ts";
import {
    type BotChatHomeStore,
    homeCanStartConversation,
    newConversationPresentation,
    preSessionFailure,
} from "../../view-models/chat/bot-chat-home-store.ts";
import { chatDiagnostics } from "../../view-models/chat/chat-diagnostics.ts";
import type { ChatWorkspace } from "../../view-models/chat/chat-workspace.ts";
import { canAddAttachments } from "../../view-models/chat/composer-attachment-store.ts";
import { botConnectionStatus } from "../../view-models/chat/computer-status-store.ts";
import {
    conversationComposerLocked,
    conversationCreationBusy,
    conversationCreationError,
    conversationCreationStatus,
    queuedDraftMessage,
} from "../../view-models/chat/conversation-creation-machine.ts";
import { selectedConversationTarget } from "../../view-models/chat/conversation-selection-machine.ts";
import type { DraftControlsStore } from "../../view-models/chat/draft-controls-store.ts";
import { activeHarnessMark, pendingExecutionContext } from "../../view-models/chat/execution-context.ts";
import {
    conversationReadPending,
    pendingConversationPresentation,
} from "../../view-models/chat/pending-conversation-presentation.ts";
import { describeLoadFailure, type PageFailure } from "../../view-models/format-error.ts";
import { reportApplicationError } from "../../view-models/report-error.ts";
import { BugReportButton } from "../diagnostics/bug-report-button.tsx";
import { OnlineComputerAlternative } from "./computer-switcher.tsx";
import { ConversationSidebar } from "./conversation-sidebar.tsx";
import { DevicesDialog } from "./devices-dialog.tsx";
import { DraftChatControls } from "./draft-chat-controls.tsx";
import { MortySessionPane, MortySessionPaneLoading, SessionMessageListSkeleton } from "./morty-session-pane.tsx";
import { PairingInstruction } from "./pairing-instruction.tsx";

/** The centered pre-session failure block: card, grouped action buttons and the report entry. */
function PreSessionFailure({
    action,
    failure,
    report,
}: {
    readonly action: ReactNode;
    readonly failure: PageFailure;
    readonly report: ReactNode;
}) {
    return (
        <div className="m-auto grid justify-items-center gap-4 text-center">
            <SessionLoadFailure copy={describeLoadFailure(failure, "Couldn't load this chat")} />
            {/* The recovery and report buttons form one group: stacked, with the group's 8px rhythm. */}
            <div className="grid justify-items-center gap-2">
                {action}
                {report}
            </div>
        </div>
    );
}

type BotChatHomeProps = {
    readonly workspace: ChatWorkspace;
};

function DraftLandingDirectory({
    disabled,
    settingsKind,
    signal,
    viewModel,
}: {
    readonly disabled: boolean;
    readonly settingsKind: DraftControlsStore["settings"]["kind"];
    readonly signal: AbortSignal;
    readonly viewModel: DraftControlsStore;
}) {
    if (settingsKind === "loading") {
        return (
            <div
                aria-hidden="true"
                className="mt-5 h-9 w-[140px] animate-pulse rounded-lg bg-morty-fill-opacity-3 motion-reduce:animate-none"
            />
        );
    }
    if (settingsKind !== "ready") {
        return null;
    }
    return (
        <div className="mt-5">
            <CwdSelector disabled={disabled} signal={signal} viewModel={viewModel} />
        </div>
    );
}

function NewSessionTitle({
    agentLabel,
    harness,
    centered,
    loading,
}: {
    readonly agentLabel: string;
    readonly harness: string;
    readonly centered: boolean;
    readonly loading: boolean;
}) {
    return (
        <h2
            className={cn(
                "flex min-w-0 items-center gap-2 text-sm font-semibold",
                centered && "w-full max-w-full justify-center",
            )}
            title="New Session"
        >
            {centered ? null : (
                <HarnessMark
                    harness={harness || agentLabel}
                    className="text-copy-secondary"
                    label={agentLabel}
                    loading={loading}
                    testId={dataTestId.sessionTitleHarnessMark}
                />
            )}
            <span className={cn("min-w-0 truncate", centered && "text-center")}>New Session</span>
        </h2>
    );
}

/** The chat home renders its desktop or compact layout as the viewport allows. */
export function BotChatHome(props: BotChatHomeProps) {
    return <DesktopChatLayout>{(desktop) => <BotChatHomeLayout {...props} desktop={desktop} />}</DesktopChatLayout>;
}

function BotChatHomeLayout({ workspace, desktop }: BotChatHomeProps & { readonly desktop: boolean }) {
    const store = workspace.home;
    const model = useStore(store);
    const computer = useStore(workspace.computer);
    const draftControls = useStore(workspace.draftControls);
    const executionContext = pendingExecutionContext(model, computer, draftControls.settings);
    const attachmentModel = useStore(model.composerAttachments);
    const connectionStatus = botConnectionStatus(computer);
    const creationBusy = conversationCreationBusy(model.creation);
    const composerLocked = conversationComposerLocked(model.creation);
    // Leaving the page cancels creation with the workspace; only other failures are unexpected.
    const createConversation = () => {
        const signal = workspace.operationsSignal();
        void store
            .getState()
            .createConversation(signal)
            .catch((cause: unknown) => {
                if (!signal.aborted) {
                    reportApplicationError(cause, "conversation-creation");
                }
            });
    };
    const creationError = conversationCreationError(model.creation);
    const creationStatus = conversationCreationStatus(model.creation);
    const queuedInitialMessage = queuedDraftMessage(model.creation);
    const draft = model.draft;
    const titles = useStore(workspace.titles, (state) => state.titles);
    const pendingConversation = pendingConversationPresentation(model.selection, computer, titles);
    const canStartConversation = homeCanStartConversation(model, computer);
    const presentation = newConversationPresentation(
        model,
        computer,
        attachmentModel,
        draftControls.settings,
        executionContext.available,
    );
    const pairingNotice = useStore(computer.pairingDialog, (state) => state.open);

    const newSessionHarness = activeHarnessMark(model, computer, draftControls.settings);
    const newSessionHarnessLoading =
        draftControls.settings.kind === "loading" || draftControls.settings.kind === "switching";
    const showNewSessionTitle = model.selection.kind === "draft";
    const activeConversationTarget = selectedConversationTarget(model.selection);
    const sessionDiagnostics: DaemonDiagnosticsSource = {
        computerId: workspace.computerId,
        harness: activeConversationTarget?.harness ?? null,
        sessionId: activeConversationTarget?.sessionId ?? null,
        context: () => chatDiagnostics(workspace),
        read: (signal) => workspace.requests.daemonDiagnostics(signal),
        readNetwork: (signal) => workspace.requests.networkDiagnostic(signal),
    };
    const reportButton = (
        <BugReportButton appearance="icon" daemonSource={sessionDiagnostics} dialog={workspace.bugReportDialog} />
    );
    // Centered failure cards keep every row on the midline, so their report entry is a
    // labelled tertiary action below the recovery actions instead of an inline icon.
    const reportEntry = (
        <BugReportButton appearance="labelled" daemonSource={sessionDiagnostics} dialog={workspace.bugReportDialog} />
    );
    const newConversation = () => {
        store.getState().newConversation();
    };
    const openManaged: BotChatHomeStore["openManaged"] = (target) => {
        store.getState().openManaged(target);
    };
    const pendingTitle = showNewSessionTitle ? (
        <NewSessionTitle
            agentLabel={newSessionHarness.label}
            harness={newSessionHarness.harness}
            centered={!desktop}
            loading={newSessionHarnessLoading}
        />
    ) : (
        <h2 className="min-w-0 truncate text-sm font-semibold">{pendingConversation.title}</h2>
    );

    return (
        <main
            aria-label="Chat"
            data-chat-state={model.selection.kind === "ready" ? "connected" : "disconnected"}
            className="fixed inset-0 flex min-h-0 overflow-hidden bg-card/90 pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] text-foreground max-sm:flex-col sm:flex-row sm:bg-sidebar"
            onPointerDownCapture={workspace.recordUserActivity}
            onKeyDownCapture={workspace.recordUserActivity}
            onInputCapture={workspace.recordUserActivity}
        >
            <ConversationSidebar
                computerId={workspace.computerId}
                workspace={workspace}
                activeTarget={activeConversationTarget}
                connectionStatus={connectionStatus}
                onConnectAgent={computer.pairing.kind === "unpaired" ? computer.pairingDialog.getState().show : null}
                onOpen={(session) => openManaged(session.target)}
                onNewConversation={newConversation}
            />
            <DevicesDialog
                accessExpiry={workspace.accessExpiry}
                devices={workspace.linkedDevices}
                computerName={computer.computerConfiguration?.computer?.computerName ?? ""}
                signal={workspace.operationsSignal}
                store={workspace.deviceAccess}
            />
            {workspace.accessNotice !== null && (
                <div
                    role="status"
                    className="fixed bottom-24 left-4 z-[100] rounded-lg border border-border bg-background px-4 py-3 text-sm shadow-lg"
                >
                    {workspace.accessNotice}
                </div>
            )}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <section aria-label="Conversation" className={chatSessionPaneSectionClassName}>
                    {model.selection.kind === "ready" ? (
                        <div
                            className={chatSessionPaneEnterClassName}
                            key={nativeSessionKey(model.selection.session.target)}
                        >
                            <MortySessionPane workspace={workspace} />
                        </div>
                    ) : conversationReadPending(model.selection, computer) && pendingConversation.recovery === null ? (
                        <MortySessionPaneLoading
                            footer={
                                <BotChatComposer
                                    attachmentModel={attachmentModel}
                                    focusScope={workspace}
                                    canAttach={canAddAttachments(attachmentModel)}
                                    attachmentSignal={workspace.operationsSignal()}
                                    disabled
                                    draft=""
                                    error=""
                                    onDraftChange={() => {}}
                                    onStop={() => {}}
                                    onSubmit={() => {}}
                                    outputState={creationBusy ? "sending" : "idle"}
                                    submitDisabled
                                >
                                    {null}
                                </BotChatComposer>
                            }
                        />
                    ) : (
                        <>
                            {desktop ? (
                                <header className={cn(chatSessionExecutionHeaderClassName, "justify-between")}>
                                    {pendingTitle}
                                </header>
                            ) : (
                                <MobileSessionTitlePortal>{pendingTitle}</MobileSessionTitlePortal>
                            )}
                            {/* Radix wraps viewport children in a table; fill its height so the landing can center. */}
                            <FollowLatestScrollArea
                                followThreshold={80}
                                followRevision={model.scrollFollowRevision}
                                className={chatSessionMessageScrollAreaClassName}
                                useProductScrollbar
                                viewportClassName={`[&>div]:h-full ${chatSessionMessageViewportClassName}`}
                                role="log"
                                aria-label="Messages"
                            >
                                <div className="flex min-h-full flex-col gap-8">
                                    {pendingConversation.recovery !== null ? (
                                        <div className="m-auto grid max-w-lg justify-items-center gap-4 px-6 text-center">
                                            <ComputerOfflineIcon />
                                            <div role="status" aria-live="polite" aria-atomic="true">
                                                <p className="font-medium">{pendingConversation.recovery.title}</p>
                                                <p className="mt-2 text-sm text-muted-foreground">
                                                    {pendingConversation.recovery.description}
                                                </p>
                                                <p className="mt-2 text-sm text-muted-foreground">
                                                    Your unsent draft will be restored with this session.
                                                </p>
                                            </div>
                                            <Button onClick={store.getState().retry}>Reconnect</Button>
                                        </div>
                                    ) : computer.entry.kind === "loading" ? (
                                        <SessionMessageListSkeleton />
                                    ) : computer.entry.kind === "failed" || model.selection.kind === "failed" ? (
                                        <PreSessionFailure
                                            action={<Button onClick={store.getState().retry}>Reconnect</Button>}
                                            failure={preSessionFailure(model.selection, computer.entry)}
                                            report={reportEntry}
                                        />
                                    ) : queuedInitialMessage !== null && creationStatus !== null ? (
                                        <div className={`${chatSessionColumnClassName} flex flex-col gap-2`}>
                                            <div data-testid={dataTestId.queuedMessage}>
                                                <UserPromptMessage
                                                    attachments={queuedInitialMessage.attachments}
                                                    status={
                                                        <MessageDeliveryStatus
                                                            data-testid={dataTestId.initialMessageStatus}
                                                            delivery={creationBusy ? "sending" : "failed"}
                                                            label={creationStatus}
                                                        />
                                                    }
                                                    text={queuedInitialMessage.content}
                                                />
                                            </div>
                                            {creationError.length > 0 && (
                                                <div
                                                    aria-live="assertive"
                                                    className="ml-auto flex max-w-[85%] items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-right text-xs text-destructive"
                                                    role="alert"
                                                >
                                                    <span className="min-w-0 flex-1 break-words">{creationError}</span>
                                                    <Button
                                                        disabled={presentation.retryDisabled}
                                                        onClick={createConversation}
                                                    >
                                                        Retry message
                                                    </Button>
                                                    {reportButton}
                                                </div>
                                            )}
                                        </div>
                                    ) : (
                                        <div className="m-auto flex max-w-lg flex-col items-center px-6">
                                            <div className="text-center" data-testid={dataTestId.chatLanding}>
                                                <MortyLogoMark className="mx-auto mb-5 block" size={56} />
                                                <h1 className="text-[18px] leading-6 font-semibold tracking-[-0.025em]">
                                                    Morty
                                                </h1>
                                                <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
                                                    Ask a question, explore your project, or start a task with your
                                                    local agent.
                                                </p>
                                            </div>
                                            {canStartConversation && model.selection.kind === "draft" && (
                                                <DraftLandingDirectory
                                                    disabled={composerLocked}
                                                    settingsKind={draftControls.settings.kind}
                                                    signal={workspace.chatSignal()}
                                                    viewModel={draftControls}
                                                />
                                            )}
                                        </div>
                                    )}
                                </div>
                            </FollowLatestScrollArea>
                            {computer.computerConfiguration !== null && model.selection.kind === "draft" && (
                                <BotChatComposer
                                    attachmentModel={attachmentModel}
                                    focusScope={workspace}
                                    canAttach={canAddAttachments(attachmentModel)}
                                    attachmentSignal={workspace.operationsSignal()}
                                    disabled={false}
                                    draft={draft}
                                    error=""
                                    connectionNotice={
                                        executionContext.feedback.kind === "hidden"
                                            ? undefined
                                            : (inline) => (
                                                  <ConnectionNotice
                                                      feedback={executionContext.feedback}
                                                      footer={<OnlineComputerAlternative model={workspace.computers} />}
                                                      inline={inline}
                                                      onRetryNow={store.getState().retry}
                                                  />
                                              )
                                    }
                                    onDraftChange={store.getState().setDraft}
                                    onStop={() => {}}
                                    onSubmit={createConversation}
                                    outputState={creationBusy ? "sending" : "idle"}
                                    submitDisabled={presentation.submitDisabled}
                                >
                                    <DraftChatControls
                                        key={model.selection.key}
                                        workspace={workspace}
                                        disabled={composerLocked || !canStartConversation}
                                    />
                                </BotChatComposer>
                            )}
                        </>
                    )}
                </section>
            </div>
            {pairingNotice && computer.pairing.kind === "unpaired" && (
                <Dialog
                    title="Connect agent"
                    description="Morty is ready. Paste this instruction into your local agent to connect it."
                    onClose={computer.pairingDialog.getState().dismiss}
                >
                    <PairingInstruction actionPresentation="dialog" />
                </Dialog>
            )}
        </main>
    );
}
