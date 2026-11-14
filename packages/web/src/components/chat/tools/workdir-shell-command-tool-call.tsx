import * as v from "valibot";
import { isOversizedToolText } from "../tool-text-preview.tsx";
import { parseJson } from "./parse-json.ts";
import { ShellCommandPresentation } from "./shell-command-presentation.tsx";
import { toolTextContent } from "./tool-display-content.ts";
import type { ToolRendererProps } from "./tool-renderer.ts";

const requestSchema = v.pipe(
    v.strictObject({
        command: v.pipe(v.string(), v.minLength(1)),
        description: v.optional(v.string()),
        timeout: v.optional(v.number()),
        workdir: v.optional(v.string()),
    }),
    v.readonly(),
);
const responseSchema = v.pipe(
    v.strictObject({
        exitCode: v.optional(v.number()),
        output: v.string(),
    }),
    v.readonly(),
);

export function matchesWorkdirShellCommandToolCall({ input }: ToolRendererProps["entry"]): boolean {
    return v.safeParse(requestSchema, parseJson(input)).success;
}

export function WorkdirShellCommandToolCall({ entry }: ToolRendererProps) {
    const displayContent = toolTextContent(entry.content);
    const response =
        displayContent === null && !isOversizedToolText(entry.output)
            ? v.safeParse(responseSchema, parseJson(entry.output))
            : null;
    const output = displayContent ?? (response?.success === true ? response.output.output.trimEnd() : entry.output);
    return <ShellCommandPresentation entry={entry} response={output} />;
}
