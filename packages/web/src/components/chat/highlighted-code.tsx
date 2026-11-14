import { dataTestId } from "@/data-testid";
import { cn } from "@/lib/utils";
import { AgentMarkdown, MAX_MARKDOWN_CHARACTERS } from "../agents/agent-markdown.tsx";
import { ToolTextPreview } from "./tool-text-preview.tsx";

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
    bash: "bash",
    c: "c",
    cc: "cpp",
    cpp: "cpp",
    css: "css",
    go: "go",
    h: "c",
    hpp: "cpp",
    html: "html",
    java: "java",
    js: "javascript",
    json: "json",
    jsx: "jsx",
    md: "markdown",
    mdx: "mdx",
    py: "python",
    rb: "ruby",
    rs: "rust",
    sh: "bash",
    sql: "sql",
    toml: "toml",
    ts: "typescript",
    tsx: "tsx",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    zsh: "bash",
};

export function languageForPath(path: string): string {
    const normalized = path.split(/[?#]/u, 1)[0] ?? path;
    const extension = normalized.match(/\.([A-Za-z0-9]+)$/u)?.[1]?.toLowerCase();
    return extension === undefined ? "markdown" : (LANGUAGE_BY_EXTENSION[extension] ?? "markdown");
}

function fencedCode(code: string, language: string): string {
    const longestFence = Math.max(0, ...Array.from(code.matchAll(/`+/gu), (match) => match[0].length));
    const fence = "`".repeat(Math.max(3, longestFence + 1));
    return `${fence}${language}\n${code}\n${fence}`;
}

function CodeLineNumbers({ code }: { readonly code: string }) {
    const lineCount = code.split("\n").length;
    return (
        <div
            aria-hidden="true"
            className="sticky left-0 z-10 self-stretch border-r border-border/70 bg-surface-subtle px-3 py-4 text-right font-mono text-xs leading-4 text-muted-foreground select-none"
            data-testid={dataTestId.filePreviewLineNumbers}
        >
            {Array.from({ length: lineCount }, (_, index) => (
                <span className="block h-4" data-line-number="" key={index.toString()}>
                    {index + 1}
                </span>
            ))}
        </div>
    );
}

/**
 * Highlighted source. Code too large to show whole is elided by `ToolTextPreview`, so it has no line numbers to offer:
 * numbers are drawn only beside lines that are all on screen.
 */
export function HighlightedCode({
    bare = false,
    code,
    language,
    lineNumbers = false,
}: {
    readonly bare?: boolean;
    readonly code: string;
    readonly language: string;
    readonly lineNumbers?: boolean;
}) {
    if (code.length > MAX_MARKDOWN_CHARACTERS) {
        return <ToolTextPreview className={cn("p-4 text-xs", bare && "max-h-none")} text={code} />;
    }
    const source = (
        <AgentMarkdown
            className={cn(
                "text-xs [&_pre]:m-0 [&_pre]:text-xs",
                bare &&
                    "[&_[data-streamdown=code-block]]:m-0 [&_[data-streamdown=code-block]]:gap-0 [&_[data-streamdown=code-block]]:rounded-none [&_[data-streamdown=code-block]]:border-0 [&_[data-streamdown=code-block]]:!bg-transparent [&_[data-streamdown=code-block]]:p-0 [&_[data-streamdown=code-block-header]]:hidden [&_[data-streamdown=code-block-actions]]:hidden [&_[data-streamdown=code-block-body]]:!max-h-none [&_[data-streamdown=code-block-body]]:rounded-none [&_[data-streamdown=code-block-body]]:border-0 [&_[data-streamdown=code-block-body]]:bg-transparent [&_[data-streamdown=code-block-body]]:!p-4",
            )}
            markdown={fencedCode(code, language)}
            streaming={false}
        />
    );
    return lineNumbers ? (
        <div className="flex min-w-0 items-start">
            <CodeLineNumbers code={code} />
            <div className="min-w-0 flex-1 [&_pre]:leading-4">{source}</div>
        </div>
    ) : (
        source
    );
}
