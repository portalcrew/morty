import * as v from "valibot";
import { isOversizedToolText } from "../tool-text-preview.tsx";
import { EditToolPresentation } from "./edit-tool-presentation.tsx";
import { parseJson } from "./parse-json.ts";
import type { ToolRendererProps } from "./tool-renderer.ts";

const changesSchema = v.pipe(
    v.strictObject({
        changes: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1), v.readonly()),
    }),
    v.readonly(),
);

function parseChanges(entry: ToolRendererProps["entry"]): v.InferOutput<typeof changesSchema> | null {
    for (const candidate of [entry.input, entry.output]) {
        if (isOversizedToolText(candidate)) {
            continue;
        }
        const parsed = v.safeParse(changesSchema, parseJson(candidate));
        if (parsed.success) {
            return parsed.output;
        }
    }
    return null;
}

export function matchesChangedFilesEditToolCall(entry: ToolRendererProps["entry"]): boolean {
    return parseChanges(entry) !== null;
}

export function ChangedFilesEditToolCall({ entry }: ToolRendererProps) {
    const changes = parseChanges(entry);
    if (changes === null) {
        return null;
    }
    const pathsWithoutRichContent = changes.changes.filter(
        (path) => !entry.content.some((content) => content.type === "diff" && content.path === path),
    );
    return (
        <EditToolPresentation entry={entry}>
            {pathsWithoutRichContent.length > 0 ? (
                <ul aria-label="Changed files" className="grid gap-1">
                    {pathsWithoutRichContent.map((path, index) => (
                        <li
                            className="truncate font-mono text-copy-secondary"
                            key={`${path}:${index.toString()}`}
                            title={path}
                        >
                            {path}
                        </li>
                    ))}
                </ul>
            ) : null}
        </EditToolPresentation>
    );
}
