import * as v from "valibot";
import { HighlightedCode, languageForPath } from "../highlighted-code.tsx";
import { isOversizedToolText, ToolTextPreview } from "../tool-text-preview.tsx";
import { parseJson } from "./parse-json.ts";
import { type NumberedCodeLine, NumberedCodeLines, ReadToolPresentation } from "./read-tool-presentation.tsx";
import { toolTextContent } from "./tool-display-content.ts";
import type { ToolRendererProps } from "./tool-renderer.ts";

const requestSchema = v.pipe(
    v.strictObject({
        file_path: v.pipe(v.string(), v.minLength(1)),
        limit: v.optional(v.number()),
        offset: v.optional(v.number()),
    }),
    v.readonly(),
);

function parseNumberedLines(value: string): readonly NumberedCodeLine[] | null {
    const normalized = value.replace(/\n+$/u, "");
    if (normalized.length === 0) {
        return null;
    }
    const lines: NumberedCodeLine[] = [];
    for (const line of normalized.split("\n")) {
        const match = /^(\d+)\t(.*)$/u.exec(line);
        if (match?.[1] === undefined || match[2] === undefined) {
            return null;
        }
        lines.push({ code: match[2], lineNumber: Number(match[1]) });
    }
    return lines;
}

export function matchesFilePathReadToolCall({ input }: ToolRendererProps["entry"]): boolean {
    return v.safeParse(requestSchema, parseJson(input)).success;
}

export function FilePathReadToolCall({ entry }: ToolRendererProps) {
    const request = v.safeParse(requestSchema, parseJson(entry.input));
    if (!request.success) {
        return null;
    }
    const response = toolTextContent(entry.content) ?? entry.output;
    const lines = isOversizedToolText(response) ? null : parseNumberedLines(response);
    return (
        <ReadToolPresentation path={request.output.file_path} state={entry.state} title={entry.title}>
            {response.length > 0 &&
                (isOversizedToolText(response) ? (
                    <ToolTextPreview className="font-mono text-xs" text={response} />
                ) : lines === null ? (
                    <div className="overflow-hidden rounded-lg bg-black/[0.035]">
                        <HighlightedCode code={response} language={languageForPath(request.output.file_path)} />
                    </div>
                ) : (
                    <NumberedCodeLines lines={lines} />
                ))}
        </ReadToolPresentation>
    );
}
