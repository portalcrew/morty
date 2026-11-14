import * as v from "valibot";
import { isOversizedToolText } from "../tool-text-preview.tsx";
import { parseJson } from "./parse-json.ts";
import { ShellCommandPresentation } from "./shell-command-presentation.tsx";
import { toolTextContent } from "./tool-display-content.ts";
import type { ToolRendererProps } from "./tool-renderer.ts";

const requestSchema = v.pipe(
    v.strictObject({
        command: v.pipe(v.string(), v.minLength(1)),
        cwd: v.optional(v.string()),
        description: v.optional(v.string()),
    }),
    v.readonly(),
);
const formattedResponseSchema = v.pipe(
    v.strictObject({
        exit_code: v.optional(v.number()),
        formatted_output: v.string(),
    }),
    v.readonly(),
);
const outputResponseSchema = v.pipe(
    v.strictObject({
        exitCode: v.optional(v.number()),
        output: v.string(),
    }),
    v.readonly(),
);
const responseSchema = v.union([formattedResponseSchema, outputResponseSchema]);

export function matchesCwdShellCommandToolCall({ input, output }: ToolRendererProps["entry"]): boolean {
    return (
        v.safeParse(requestSchema, parseJson(input)).success ||
        (!isOversizedToolText(output) && v.safeParse(outputResponseSchema, parseJson(output)).success)
    );
}

export function CwdShellCommandToolCall({ entry }: ToolRendererProps) {
    const displayContent = toolTextContent(entry.content);
    const response =
        displayContent === null && !isOversizedToolText(entry.output)
            ? v.safeParse(responseSchema, parseJson(entry.output))
            : null;
    const output =
        displayContent ??
        (response?.success === true
            ? ("output" in response.output ? response.output.output : response.output.formatted_output).trimEnd()
            : entry.output);
    return <ShellCommandPresentation entry={entry} response={output} />;
}
