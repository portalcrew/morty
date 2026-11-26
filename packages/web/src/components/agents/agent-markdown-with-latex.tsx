import { createMathPlugin } from "@streamdown/math";
import "katex/dist/katex.min.css";
import type { AgentMarkdownProps } from "./agent-markdown.tsx";
import { AgentMarkdownContent } from "./agent-markdown-renderer.tsx";

const MATH_PLUGIN = createMathPlugin({ singleDollarTextMath: true });

export function AgentMarkdownWithLatex(properties: AgentMarkdownProps) {
    return <AgentMarkdownContent {...properties} mathPlugin={MATH_PLUGIN} />;
}
