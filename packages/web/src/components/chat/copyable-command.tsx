import { Check, Copy } from "lucide-react";
import { CopyToClipboardButton } from "../ui/copy-to-clipboard-button.tsx";
import { ScrollArea } from "../ui/scroll-area.tsx";

/** A command to run on the computer: monospace and unbroken so it can be typed exactly, with a copy action. */
export function CopyableCommand({ command }: { readonly command: string }) {
    return (
        <span className="inline-flex min-w-0 max-w-full items-center gap-1">
            <ScrollArea
                className="min-w-0 max-w-full shrink rounded-md bg-muted"
                orientation="horizontal"
                viewportClassName="max-w-full"
            >
                <code className="whitespace-nowrap px-1.5 py-0.5 font-mono text-[11px] leading-4 text-foreground">
                    {command}
                </code>
            </ScrollArea>
            <CopyToClipboardButton
                className="w-7 px-0"
                copiedContent={<Check aria-hidden="true" className="size-3.5" />}
                failureToast={{ description: "Select the command and copy it manually.", title: "Could not copy" }}
                label="Copy command"
                size="xs"
                successToast={{ description: "Run it in a terminal on that computer.", title: "Command copied" }}
                value={command}
                variant="ghost"
            >
                <Copy aria-hidden="true" className="size-3.5" />
            </CopyToClipboardButton>
        </span>
    );
}
