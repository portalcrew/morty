import * as v from "valibot";
import { EditToolPresentation, FileDiffList, fileDiffsWithoutRichContent } from "./edit-tool-presentation.tsx";
import type { ToolRendererProps } from "./tool-renderer.ts";

const inputSchema = v.pipe(
    v.array(
        v.object({
            newText: v.nullable(v.string()),
            oldText: v.nullable(v.string()),
            path: v.pipe(v.string(), v.minLength(1)),
            type: v.literal("diff"),
        }),
    ),
    v.readonly(),
);

function parseJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

export function matchesInputDiffEditToolCall({ input }: ToolRendererProps["entry"]): boolean {
    return v.safeParse(inputSchema, parseJson(input)).success;
}

export function InputDiffEditToolCall({ entry }: ToolRendererProps) {
    const input = v.safeParse(inputSchema, parseJson(entry.input));
    if (!input.success) {
        return null;
    }
    return (
        <EditToolPresentation entry={entry}>
            <FileDiffList diffs={fileDiffsWithoutRichContent(input.output, entry)} />
        </EditToolPresentation>
    );
}
