import { Check, Copy } from "lucide-react";
import { useStore } from "zustand";
import { executionDetailsTermClassName } from "../../components/chat/execution-details-dialog.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { CopyToClipboardButton } from "../../components/ui/copy-to-clipboard-button.tsx";
import { mortyUpdatePrompt } from "../../services/release/morty-release.ts";
import type { ComputerReleaseStoreApi } from "../../view-models/chat/computer-release-store.ts";

/**
 * The release this Computer runs and, when the page's own release is newer, the way to update it: a new conversation
 * whose draft asks the Agent, for the person to review and send, or the same prompt to paste elsewhere.
 */
export function MortyVersion({
    release,
    onAskAgent,
}: {
    readonly release: ComputerReleaseStoreApi;
    readonly onAskAgent: () => void;
}) {
    const state = useStore(release, (model) => model.state);
    if (state.kind === "unknown") {
        return null;
    }
    return (
        <>
            <dt className={executionDetailsTermClassName}>Morty version</dt>
            <dd className="min-w-0 text-foreground">
                <span className="block">{state.running}</span>
                {state.kind === "outdated" && (
                    <>
                        <span className="mt-1 block text-xs text-muted-foreground">
                            {state.latest} is available. When no task is running, ask your agent on this computer to
                            update it.
                        </span>
                        <span className="mt-2.5 flex items-center gap-1">
                            <Button onClick={onAskAgent} size="sm" variant="outline">
                                Ask agent to update
                            </Button>
                            <CopyToClipboardButton
                                className="w-8 px-0"
                                copiedContent={<Check aria-hidden="true" />}
                                failureToast={{
                                    description:
                                        "Ask your agent to run `npx --yes @portalcrew/morty@latest restart` as a detached background process.",
                                    title: "Could not copy",
                                }}
                                label="Copy update prompt"
                                size="sm"
                                successToast={{
                                    description:
                                        "Send it to your agent on that computer. Morty restarts after it replies.",
                                    title: "Copied",
                                }}
                                value={mortyUpdatePrompt}
                                variant="ghost"
                            >
                                <Copy aria-hidden="true" />
                            </CopyToClipboardButton>
                        </span>
                    </>
                )}
            </dd>
        </>
    );
}
