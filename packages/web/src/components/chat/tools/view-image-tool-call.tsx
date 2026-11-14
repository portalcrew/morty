import { Image as ImageIcon } from "lucide-react";
import { ToolCallDisclosure } from "./tool-call-status.tsx";
import type { ToolRendererProps } from "./tool-renderer.ts";

export function matchesViewImageToolCall(entry: ToolRendererProps["entry"]): boolean {
    return (
        (entry.name === "view_image" || entry.name.endsWith("/view_image") || entry.title === "View image") &&
        entry.content.some((content) => content.type === "image")
    );
}

export function ViewImageToolCall({ entry }: ToolRendererProps) {
    return (
        <ToolCallDisclosure
            ariaLabel={`Tool: ${entry.title}`}
            icon={<ImageIcon aria-hidden="true" className="size-4 shrink-0" />}
            state={entry.state}
            title={entry.title}
        />
    );
}
