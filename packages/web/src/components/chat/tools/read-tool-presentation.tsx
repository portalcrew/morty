import { FileText } from "lucide-react";
import type { ReactNode } from "react";
import { ToolCallDisclosure } from "./tool-call-status.tsx";
import type { ToolCallState } from "./tool-renderer.ts";

export interface NumberedCodeLine {
    readonly code: string;
    readonly lineNumber: number;
}

export function NumberedCodeLines({ lines }: { readonly lines: readonly NumberedCodeLine[] }) {
    return (
        <div className="rounded-lg bg-black/[0.035] p-2 font-mono text-xs leading-5">
            {lines.map((line) => (
                <div className="grid min-w-max grid-cols-[max-content_minmax(0,1fr)] gap-3" key={line.lineNumber}>
                    <span className="select-none text-right text-copy-tertiary">{line.lineNumber}</span>
                    <code className="whitespace-pre">{line.code}</code>
                </div>
            ))}
        </div>
    );
}

export function ReadToolLabel({ children }: { readonly children: string }) {
    return (
        <span className="inline-flex w-fit rounded-md bg-black/[0.035] px-2 py-1 font-medium text-copy-secondary">
            {children}
        </span>
    );
}

export function ReadToolPresentation({
    children,
    path,
    state,
    title,
}: {
    readonly children: ReactNode;
    readonly path: string;
    readonly state: ToolCallState;
    readonly title: string;
}) {
    return (
        <ToolCallDisclosure
            ariaLabel={`Read: ${title}`}
            icon={<FileText aria-hidden="true" className="size-4 shrink-0" />}
            state={state}
            title={title}
        >
            <div className="grid min-w-0 gap-2 text-xs">
                <div className="truncate font-mono text-copy-secondary" title={path}>
                    {path}
                </div>
                {children}
            </div>
        </ToolCallDisclosure>
    );
}
