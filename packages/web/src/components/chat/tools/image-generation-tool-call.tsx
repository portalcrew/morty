import { Image as ImageIcon } from "lucide-react";
import * as v from "valibot";
import { ToolCallDisclosure } from "./tool-call-status.tsx";
import type { ToolRendererProps } from "./tool-renderer.ts";

const requestSchema = v.pipe(
    v.strictObject({
        prompt: v.pipe(v.string(), v.minLength(1), v.maxLength(32_768)),
    }),
    v.readonly(),
);

function promptFrom(input: string): string | null {
    try {
        const request = v.safeParse(requestSchema, JSON.parse(input));
        return request.success ? request.output.prompt : null;
    } catch {
        return null;
    }
}

export function matchesImageGenerationToolCall(entry: ToolRendererProps["entry"]): boolean {
    return entry.title === "Generate image" && entry.content.some((content) => content.type === "image");
}

export function ImageGenerationToolCall({ entry }: ToolRendererProps) {
    const prompt = promptFrom(entry.input);
    return (
        <ToolCallDisclosure
            ariaLabel={`Tool: ${entry.title}`}
            icon={<ImageIcon aria-hidden="true" className="size-4 shrink-0" />}
            state={entry.state}
            title={entry.title}
        >
            {prompt !== null && <p className="m-0 text-xs leading-5 text-copy-secondary">{prompt}</p>}
        </ToolCallDisclosure>
    );
}
