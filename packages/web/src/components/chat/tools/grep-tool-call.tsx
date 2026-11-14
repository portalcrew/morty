import * as v from "valibot";
import { parseJson } from "./parse-json.ts";
import { SearchToolPresentation } from "./search-tool-presentation.tsx";
import type { ToolRendererProps } from "./tool-renderer.ts";

const requestSchema = v.pipe(
    v.strictObject({
        caseSensitive: v.optional(v.boolean()),
        include: v.optional(v.string()),
        limit: v.optional(v.number()),
        literal: v.optional(v.boolean()),
        path: v.optional(v.string()),
        pattern: v.pipe(v.string(), v.minLength(1)),
    }),
    v.readonly(),
);

export function matchesGrepToolCall({ input }: ToolRendererProps["entry"]): boolean {
    return v.safeParse(requestSchema, parseJson(input)).success;
}

export function GrepToolCall({ entry }: ToolRendererProps) {
    const request = v.safeParse(requestSchema, parseJson(entry.input));
    if (!request.success) {
        return null;
    }
    return <SearchToolPresentation entry={entry} path={request.output.path ?? "."} />;
}
