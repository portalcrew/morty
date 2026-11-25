import { Check, Copy } from "lucide-react";
import { useStore } from "zustand";
import { executionDetailsTermClassName } from "../../components/chat/execution-details-dialog.tsx";
import { CopyToClipboardButton } from "../../components/ui/copy-to-clipboard-button.tsx";
import { mortyUpdatePrompt } from "../../services/release/morty-release.ts";
import type { ComputerReleaseStoreApi } from "../../view-models/chat/computer-release-store.ts";

/** The release this Computer runs and, when the page's own release is newer, the prompt that updates it. */
export function MortyVersion({ release }: { readonly release: ComputerReleaseStoreApi }) {
    const state = useStore(release, (model) => model.state);
    if (state.kind === "unknown") {
        return null;
    }
    return (
        <>
            <dt className={executionDetailsTermClassName}>Morty version</dt>
            <dd className="min-w-0 text-foreground">
                <span className="block">{state.running}</span>
                {(state.kind === "available" || state.kind === "overdue") && (
                    <>
                        <span className="mt-1 block text-xs text-muted-foreground">
                            {state.latest} is available. When no task is running, send the update prompt to your agent
                            on this computer.
                        </span>
                        <CopyToClipboardButton
                            className="mt-2.5"
                            copiedContent={
                                <>
                                    <Check aria-hidden="true" />
                                    Copied
                                </>
                            }
                            failureToast={{
                                description:
                                    "Ask your agent on that computer to run `npx --yes @portalcrew/morty@latest update`.",
                                title: "Could not copy",
                            }}
                            label="Copy update prompt"
                            size="sm"
                            successToast={{
                                description: "Send it to your agent on that computer. Morty restarts after it replies.",
                                title: "Copied",
                            }}
                            value={mortyUpdatePrompt}
                            variant="outline"
                        >
                            <Copy aria-hidden="true" />
                            <span>Copy update prompt</span>
                        </CopyToClipboardButton>
                    </>
                )}
            </dd>
        </>
    );
}
