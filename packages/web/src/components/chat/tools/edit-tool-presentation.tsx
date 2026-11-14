import { FileDiff } from "lucide-react";
import type { ReactNode } from "react";
import { HighlightedCode, languageForPath } from "../highlighted-code.tsx";
import { ToolCallDisclosure } from "./tool-call-status.tsx";
import type { ToolRendererProps } from "./tool-renderer.ts";

export interface FileDiffValue {
    readonly newText: string | null;
    readonly oldText: string | null;
    readonly path: string;
}

export function fileDiffsWithoutRichContent(
    diffs: readonly FileDiffValue[],
    entry: ToolRendererProps["entry"],
): readonly FileDiffValue[] {
    return diffs.filter(
        (diff) =>
            !entry.content.some(
                (content) =>
                    content.type === "diff" &&
                    content.path === diff.path &&
                    content.oldText === (diff.oldText ?? "") &&
                    content.newText === (diff.newText ?? ""),
            ),
    );
}

export function FileDiffList({ diffs }: { readonly diffs: readonly FileDiffValue[] }) {
    return diffs.map((diff) => (
        <section className="min-w-0 overflow-hidden rounded-lg border border-black/7" key={diff.path}>
            <div className="truncate border-b border-black/7 bg-black/[0.025] px-2.5 py-1.5 font-mono text-copy-secondary">
                {diff.path}
            </div>
            <div className="grid font-mono text-[11px] leading-[18px] md:grid-cols-2">
                <div className="min-w-0 bg-[#fff4f2] text-[#8f2f35]">
                    <HighlightedCode code={diff.oldText ?? ""} language={languageForPath(diff.path)} />
                </div>
                <div className="min-w-0 bg-[#effaf4] text-[#17663f]">
                    <HighlightedCode code={diff.newText ?? ""} language={languageForPath(diff.path)} />
                </div>
            </div>
        </section>
    ));
}

export function EditToolPresentation({ children, entry }: ToolRendererProps & { readonly children: ReactNode }) {
    return (
        <ToolCallDisclosure
            ariaLabel={`Edit: ${entry.title}`}
            icon={<FileDiff aria-hidden="true" className="size-4 shrink-0" />}
            state={entry.state}
            title={entry.title}
        >
            {children !== null && children !== undefined && (
                <div className="grid min-w-0 gap-2 text-xs">{children}</div>
            )}
        </ToolCallDisclosure>
    );
}
