import { Terminal } from "lucide-react";
import { AnsiShellOutput } from "./ansi-shell-output.tsx";
import { ToolCallDisclosure } from "./tool-call-status.tsx";
import type { ToolRendererProps } from "./tool-renderer.ts";

export function ShellCommandPresentation({ entry, response }: ToolRendererProps & { readonly response: string }) {
    return (
        <ToolCallDisclosure
            ariaLabel={`Shell command: ${entry.title}`}
            icon={<Terminal aria-hidden="true" className="size-4 shrink-0" />}
            state={entry.state}
            title={entry.title}
        >
            <pre className="m-0 whitespace-pre-wrap font-sans text-xs leading-5 text-copy-secondary [overflow-wrap:anywhere]">
                {entry.title}
            </pre>
            {response.length > 0 && (
                <div className="overflow-hidden rounded-lg bg-black/[0.035]">
                    <AnsiShellOutput output={response} />
                </div>
            )}
        </ToolCallDisclosure>
    );
}
