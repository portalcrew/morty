import { Search } from "lucide-react";
import { ToolTextPreview } from "../tool-text-preview.tsx";
import { ToolCallDisclosure } from "./tool-call-status.tsx";
import { toolTextContent } from "./tool-display-content.ts";
import type { ToolRendererProps } from "./tool-renderer.ts";

export function SearchToolPresentation({ entry, path }: ToolRendererProps & { readonly path: string }) {
    const result = toolTextContent(entry.content) ?? entry.output;
    return (
        <ToolCallDisclosure
            ariaLabel={`Search: ${entry.title}`}
            icon={<Search aria-hidden="true" className="size-4 shrink-0" />}
            state={entry.state}
            title={entry.title}
        >
            <div className="grid min-w-0 gap-2 text-xs">
                <div className="truncate font-mono text-copy-secondary" title={path}>
                    {path}
                </div>
                {result.length > 0 && (
                    <div className="grid gap-1">
                        <span className="font-medium text-copy-tertiary">Results</span>
                        <ToolTextPreview text={result} />
                    </div>
                )}
            </div>
        </ToolCallDisclosure>
    );
}
