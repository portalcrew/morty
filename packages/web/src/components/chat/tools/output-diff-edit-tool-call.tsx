import * as v from "valibot";
import { isOversizedToolText } from "../tool-text-preview.tsx";
import { EditToolPresentation, FileDiffList, fileDiffsWithoutRichContent } from "./edit-tool-presentation.tsx";
import type { ToolRendererProps } from "./tool-renderer.ts";

const outputSchema = v.pipe(
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

export function matchesOutputDiffEditToolCall({ output }: ToolRendererProps["entry"]): boolean {
    return !isOversizedToolText(output) && v.safeParse(outputSchema, parseJson(output)).success;
}

export function OutputDiffEditToolCall({ entry }: ToolRendererProps) {
    const output = v.safeParse(outputSchema, parseJson(entry.output));
    if (!output.success) {
        return null;
    }
    return (
        <EditToolPresentation entry={entry}>
            <FileDiffList diffs={fileDiffsWithoutRichContent(output.output, entry)} />
        </EditToolPresentation>
    );
}
