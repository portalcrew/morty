import { BookOpen } from "lucide-react";
import * as v from "valibot";
import { ToolCallDisclosure } from "./tool-call-status.tsx";
import type { ToolRendererProps } from "./tool-renderer.ts";

const inputSchema = v.pipe(
    v.strictObject({
        args: v.string(),
        skill: v.pipe(v.string(), v.minLength(1)),
    }),
    v.readonly(),
);

function parseInput(value: string): v.InferOutput<typeof inputSchema> | null {
    try {
        const decoded: unknown = JSON.parse(value);
        const input = v.safeParse(inputSchema, decoded);
        return input.success ? input.output : null;
    } catch {
        return null;
    }
}

export function matchesSkillToolCall({ input }: ToolRendererProps["entry"]): boolean {
    return parseInput(input) !== null;
}

export function SkillToolCall({ entry }: ToolRendererProps) {
    const input = parseInput(entry.input);
    if (input === null) {
        return null;
    }
    const title = `Load skill: ${input.skill}`;
    return (
        <ToolCallDisclosure
            ariaLabel={`Skill: ${input.skill}`}
            icon={<BookOpen aria-hidden="true" className="size-4 shrink-0" />}
            state={entry.state}
            title={title}
        >
            {input.args.length > 0 && (
                <div className="rounded-lg bg-black/[0.035] p-2 text-xs whitespace-pre-wrap">{input.args}</div>
            )}
        </ToolCallDisclosure>
    );
}
