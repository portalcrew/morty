import { CircleAlert, CircleHelp, RefreshCw } from "lucide-react";
import { Tooltip } from "radix-ui";
import { useStore } from "zustand";
import { dataTestId } from "@/data-testid";
import { ChatConfigurationMenu } from "../../components/chat/chat-configuration-menu.tsx";
import { MortyTooltipContent } from "../../components/ui/morty-tooltip-content.tsx";
import type { ChatWorkspace } from "../../view-models/chat/chat-workspace.ts";
import { draftHarnessSelection, draftShownOptions } from "../../view-models/chat/draft-controls-store.ts";
import { useExternalStore } from "../../view-models/external-store.ts";
import { computerDisconnectedMessage } from "../../view-models/format-error.ts";

function DraftChatControlsSkeleton() {
    return (
        <div aria-label="Loading harness and model settings" className="flex min-w-0 items-center gap-1" role="status">
            <span className="sr-only">Loading harness and model settings</span>
            <div
                aria-hidden="true"
                className="h-9 w-[200px] max-w-full shrink-0 animate-pulse rounded-lg bg-morty-fill-opacity-3 motion-reduce:animate-none"
            />
        </div>
    );
}

export function DraftChatControls({
    workspace,
    disabled,
}: {
    readonly workspace: ChatWorkspace;
    readonly disabled: boolean;
}) {
    const viewModel = useExternalStore(workspace.draftControls);
    // The picker offers the Agents the Computer offers now, which can change while the draft is open.
    const computerConfiguration = useStore(workspace.computer, (state) => state.computerConfiguration);
    const signal = workspace.chatSignal();
    const { settings } = viewModel;
    const retry = () => {
        workspace.retryDraftControls();
    };
    if (settings.kind === "loading") {
        return <DraftChatControlsSkeleton />;
    }
    if (settings.kind === "failed" || settings.kind === "unreachable") {
        const message = settings.kind === "unreachable" ? computerDisconnectedMessage : settings.message;
        return (
            <div className="flex min-w-0 items-center gap-1">
                <span className="sr-only" role="alert">
                    {message}
                </span>
                <button
                    className="flex h-9 min-w-0 max-w-48 items-center gap-1.5 rounded-lg px-2 text-[13px] text-destructive outline-none transition-colors hover:bg-destructive/8 keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-destructive/30 motion-reduce:transition-none"
                    onClick={retry}
                    type="button"
                >
                    <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
                    <span className="truncate">Retry settings</span>
                    <RefreshCw aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />
                </button>
                <Tooltip.Provider delayDuration={150}>
                    <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                            <button
                                aria-label="Why settings are unavailable"
                                className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/50 motion-reduce:transition-none"
                                type="button"
                            >
                                <CircleHelp aria-hidden="true" className="size-4" />
                            </button>
                        </Tooltip.Trigger>
                        <Tooltip.Portal>
                            <MortyTooltipContent className="max-w-80 px-3 py-2 leading-5" side="top" sideOffset={8}>
                                {message}
                                <Tooltip.Arrow className="fill-foreground" />
                            </MortyTooltipContent>
                        </Tooltip.Portal>
                    </Tooltip.Root>
                </Tooltip.Provider>
            </div>
        );
    }
    const switching = settings.kind === "switching";
    const settingsLoading = switching || settings.kind === "refreshing";
    const harness = draftHarnessSelection(settings, computerConfiguration);
    // Settings kept on screen while new ones load cannot be changed.
    const options = draftShownOptions(settings);
    const model = options.find((option) => option.category === "model" && option.type !== "boolean");
    return (
        <div className="flex min-w-0 items-center gap-1">
            <ChatConfigurationMenu
                controls={[
                    {
                        disabled: disabled || settingsLoading,
                        id: "harness",
                        kind: "select" as const,
                        label: "Harness",
                        onValueChange: (value) => {
                            void viewModel.selectHarness(value, disabled, signal);
                        },
                        options: harness.options,
                        value: harness.value,
                    },
                    ...options.map((option) =>
                        option.type === "boolean"
                            ? {
                                  checked: option.booleanValue,
                                  disabled: disabled || settingsLoading,
                                  id: option.id,
                                  kind: "boolean" as const,
                                  label: option.name,
                                  onCheckedChange: () => viewModel.toggleOption(option.id),
                                  testId: dataTestId.agentSetting(option.id),
                              }
                            : {
                                  disabled: disabled || settingsLoading,
                                  id: option.id,
                                  kind: "select" as const,
                                  label: option.name,
                                  onValueChange: (value: string) => viewModel.selectOption(option.id, value),
                                  options: option.values.map((value) => ({ value: value.value, label: value.name })),
                                  searchable: option.category === "model",
                                  testId: dataTestId.agentSetting(option.id),
                                  value: option.currentValue,
                              },
                    ),
                ]}
                settingsLoading={settingsLoading}
            />
            {!switching && model === undefined && (
                <span className="sr-only">This harness has not reported any model choices.</span>
            )}
        </div>
    );
}
