import * as v from "valibot";
import { HighlightedCode, languageForPath } from "../highlighted-code.tsx";
import { isOversizedToolText, ToolTextPreview } from "../tool-text-preview.tsx";
import { parseJson } from "./parse-json.ts";
import {
    type NumberedCodeLine,
    NumberedCodeLines,
    ReadToolLabel,
    ReadToolPresentation,
} from "./read-tool-presentation.tsx";
import { toolTextContent } from "./tool-display-content.ts";
import type { ToolRendererProps } from "./tool-renderer.ts";

const requestSchema = v.pipe(
    v.strictObject({
        limit: v.optional(v.number()),
        offset: v.optional(v.number()),
        path: v.pipe(v.string(), v.minLength(1)),
    }),
    v.readonly(),
);
const responseSchema = v.pipe(
    v.strictObject({
        exit_code: v.optional(v.number()),
        formatted_output: v.string(),
    }),
    v.readonly(),
);

interface ParsedOutput {
    readonly body: string;
    readonly continuationLabel: string;
    readonly lines: readonly NumberedCodeLine[] | null;
    readonly rangeLabel: string;
}

function responseText(value: string): string {
    const response = v.safeParse(responseSchema, parseJson(value));
    return response.success ? response.output.formatted_output.trimEnd() : value;
}

function parseNumberedLines(value: string): readonly NumberedCodeLine[] | null {
    if (value.length === 0) {
        return null;
    }
    const lines: NumberedCodeLine[] = [];
    for (const line of value.split("\n")) {
        const match = /^(\d+): ?(.*)$/u.exec(line);
        if (match?.[1] === undefined || match[2] === undefined) {
            return null;
        }
        lines.push({ code: match[2], lineNumber: Number(match[1]) });
    }
    return lines;
}

function parseOutput(value: string): ParsedOutput {
    const lines = value.replace(/\n+$/u, "").split("\n");
    const header = /^Read file .+, lines (\d+)-(\d+)$/u.exec(lines[0] ?? "");
    const continuation = /^\[Output truncated\. Continue reading with offset: (\d+)\]$/u.exec(lines.at(-1) ?? "");
    const body = lines.slice(header === null ? 0 : 1, continuation === null ? lines.length : -1).join("\n");
    return {
        body,
        continuationLabel: continuation?.[1] === undefined ? "" : `Continue reading at line ${continuation[1]}`,
        lines: parseNumberedLines(body),
        rangeLabel: header?.[1] === undefined || header[2] === undefined ? "" : `Lines ${header[1]}–${header[2]}`,
    };
}

export function matchesPathReadToolCall({ input }: ToolRendererProps["entry"]): boolean {
    return v.safeParse(requestSchema, parseJson(input)).success;
}

export function PathReadToolCall({ entry }: ToolRendererProps) {
    const request = v.safeParse(requestSchema, parseJson(entry.input));
    if (!request.success) {
        return null;
    }
    const content = toolTextContent(entry.content);
    const response = content ?? (isOversizedToolText(entry.output) ? entry.output : responseText(entry.output));
    if (isOversizedToolText(response)) {
        return (
            <ReadToolPresentation path={request.output.path} state={entry.state} title={entry.title}>
                <ToolTextPreview className="font-mono text-xs" text={response} />
            </ReadToolPresentation>
        );
    }
    const parsed = parseOutput(response);
    return (
        <ReadToolPresentation path={request.output.path} state={entry.state} title={entry.title}>
            {parsed.rangeLabel.length > 0 && <ReadToolLabel>{parsed.rangeLabel}</ReadToolLabel>}
            {parsed.body.length > 0 &&
                (parsed.lines === null ? (
                    <div className="overflow-hidden rounded-lg bg-black/[0.035]">
                        <HighlightedCode code={parsed.body} language={languageForPath(request.output.path)} />
                    </div>
                ) : (
                    <NumberedCodeLines lines={parsed.lines} />
                ))}
            {parsed.continuationLabel.length > 0 && <ReadToolLabel>{parsed.continuationLabel}</ReadToolLabel>}
        </ReadToolPresentation>
    );
}
