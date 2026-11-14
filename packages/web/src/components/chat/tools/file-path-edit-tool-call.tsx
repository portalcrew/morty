import * as v from "valibot";
import { EditToolPresentation, FileDiffList, fileDiffsWithoutRichContent } from "./edit-tool-presentation.tsx";
import type { ToolRendererProps } from "./tool-renderer.ts";

const inputSchema = v.pipe(
    v.strictObject({
        file_path: v.pipe(v.string(), v.minLength(1)),
        new_string: v.string(),
        old_string: v.string(),
        replace_all: v.boolean(),
    }),
    v.readonly(),
);

function parseJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

export function matchesFilePathEditToolCall({ input }: ToolRendererProps["entry"]): boolean {
    return v.safeParse(inputSchema, parseJson(input)).success;
}

export function FilePathEditToolCall({ entry }: ToolRendererProps) {
    const input = v.safeParse(inputSchema, parseJson(entry.input));
    if (!input.success) {
        return null;
    }
    return (
        <EditToolPresentation entry={entry}>
            <FileDiffList
                diffs={fileDiffsWithoutRichContent(
                    [
                        {
                            newText: input.output.new_string,
                            oldText: input.output.old_string,
                            path: input.output.file_path,
                        },
                    ],
                    entry,
                )}
            />
        </EditToolPresentation>
    );
}
