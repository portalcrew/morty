import { EditToolPresentation } from "./edit-tool-presentation.tsx";
import type { ToolRendererProps } from "./tool-renderer.ts";

export function matchesRichContentEditToolCall({ content }: ToolRendererProps["entry"]): boolean {
    return content.some((item) => item.type === "diff");
}

export function RichContentEditToolCall({ entry }: ToolRendererProps) {
    return <EditToolPresentation entry={entry}>{null}</EditToolPresentation>;
}
