import * as v from "valibot";
import { HighlightedCode } from "../highlighted-code.tsx";
import { EditToolPresentation } from "./edit-tool-presentation.tsx";
import { parseJson } from "./parse-json.ts";
import type { ToolRendererProps } from "./tool-renderer.ts";

const inputSchema = v.pipe(
    v.strictObject({
        patchText: v.pipe(v.string(), v.minLength(1)),
    }),
    v.readonly(),
);

export function matchesPatchEditToolCall({ input }: ToolRendererProps["entry"]): boolean {
    return v.safeParse(inputSchema, parseJson(input)).success;
}

export function PatchEditToolCall({ entry }: ToolRendererProps) {
    const input = v.safeParse(inputSchema, parseJson(entry.input));
    if (!input.success) {
        return null;
    }
    return (
        <EditToolPresentation entry={entry}>
            <div className="overflow-hidden rounded-lg border border-black/7 bg-black/[0.025]">
                <HighlightedCode code={input.output.patchText} language="diff" />
            </div>
        </EditToolPresentation>
    );
}
