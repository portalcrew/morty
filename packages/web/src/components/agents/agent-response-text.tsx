import { memo, useState } from "react";
import { textLinkClassName } from "../ui/text-link.ts";
import { AgentMarkdown, type MarkdownImageReader } from "./agent-markdown.tsx";

const PREVIEW_CHARACTERS = 32_000;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type ResponseProps = {
    readonly text: string;
    readonly streaming: boolean;
    readonly openLocalFile: (path: string) => void;
    readonly readImage?: MarkdownImageReader | undefined;
};

type MarkdownPreviewProps = ResponseProps & { readonly sourceCharacters: number };

const MarkdownPreview = memo(function MarkdownPreview({
    text,
    openLocalFile,
    readImage,
    sourceCharacters,
    streaming,
}: MarkdownPreviewProps) {
    return (
        <AgentMarkdown
            markdown={text}
            openLocalFile={openLocalFile}
            readImage={readImage}
            sourceCharacters={sourceCharacters}
            streaming={streaming}
        />
    );
});

export function AgentResponseText({ text, openLocalFile, readImage, streaming }: ResponseProps) {
    const [visibleCharacters, setVisibleCharacters] = useState(PREVIEW_CHARACTERS);
    // Expand one document, rather than independent fragments: the Markdown parser
    // retains list, table, quote and code context across every expansion.
    const end =
        text.length <= visibleCharacters
            ? text.length
            : (graphemes.segment(text.slice(0, visibleCharacters + 2)).containing(visibleCharacters)?.index ??
              visibleCharacters);
    const beginning = text.slice(0, end);
    const truncated = end < text.length;
    const tailOffset = Math.max(end, text.length - PREVIEW_CHARACTERS);
    const character = text.charCodeAt(tailOffset);
    const tailStart = character >= 0xdc00 && character <= 0xdfff ? tailOffset + 1 : tailOffset;
    return (
        <div>
            <MarkdownPreview
                text={beginning}
                openLocalFile={openLocalFile}
                readImage={readImage}
                sourceCharacters={text.length}
                streaming={streaming}
            />
            {truncated && (
                <div className="my-3 space-y-2 text-sm text-muted-foreground">
                    <p>The Markdown preview shows the beginning of this response. Load more to read additional text.</p>
                    <button
                        className={textLinkClassName}
                        onClick={() => setVisibleCharacters((current) => current + PREVIEW_CHARACTERS)}
                        type="button"
                    >
                        Load more text
                    </button>
                    <p>Latest output (text preview)</p>
                    <pre className="whitespace-pre-wrap break-words font-sans text-base leading-6 text-foreground">
                        {text.slice(tailStart)}
                    </pre>
                </div>
            )}
        </div>
    );
}
