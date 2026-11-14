import * as v from "valibot";
import { HighlightedCode } from "../highlighted-code.tsx";
import { isOversizedToolText, ToolTextPreview } from "../tool-text-preview.tsx";
import { EditToolPresentation } from "./edit-tool-presentation.tsx";
import type { ToolRendererProps } from "./tool-renderer.ts";

const textContentSchema = v.pipe(
    v.object({
        text: v.string(),
        type: v.literal("text"),
    }),
    v.readonly(),
);

const resultSchema = v.pipe(
    v.object({
        content: v.pipe(v.array(textContentSchema), v.readonly()),
        details: v.optional(
            v.pipe(
                v.object({
                    diff: v.optional(v.string()),
                }),
                v.readonly(),
            ),
        ),
        isError: v.boolean(),
        role: v.literal("toolResult"),
        toolCallId: v.string(),
        toolName: v.union([v.literal("edit"), v.literal("write")]),
    }),
    v.readonly(),
);

function parseResult(output: string): v.InferOutput<typeof resultSchema> | null {
    if (isOversizedToolText(output)) {
        return null;
    }
    try {
        const result = v.safeParse(resultSchema, JSON.parse(output));
        return result.success ? result.output : null;
    } catch {
        return null;
    }
}

export function matchesPiFileToolCall({ output }: ToolRendererProps["entry"]): boolean {
    return parseResult(output) !== null;
}

export function PiFileToolCall({ entry }: ToolRendererProps) {
    const result = parseResult(entry.output);
    if (result === null) {
        return null;
    }
    const text = result.content.map((item) => item.text).join("\n");
    return (
        <EditToolPresentation entry={entry}>
            {result.details?.diff === undefined ? (
                text.length > 0 ? (
                    <ToolTextPreview text={text} />
                ) : null
            ) : (
                <div className="overflow-hidden rounded-lg border border-black/7 bg-black/[0.025]">
                    <HighlightedCode code={result.details.diff} language="diff" />
                </div>
            )}
        </EditToolPresentation>
    );
}
