import { memo, useEffect, useState } from "react";
import { CodeBlock, type CustomRendererProps } from "streamdown";
import { MAX_MERMAID_CHARACTERS } from "./mermaid-options.ts";
import { INCOMPLETE_MERMAID_META } from "./remark-mermaid-completion.ts";

function MermaidSource({ code, message }: { readonly code: string; readonly message: string }) {
    return (
        <div>
            <p className="text-sm text-muted-foreground" role="status">
                {message}
            </p>
            <CodeBlock code={code} language="mermaid" lineNumbers={false} />
        </div>
    );
}

type DiagramComponent = typeof import("./mermaid-diagram.tsx")["default"];
let diagramComponent: Promise<DiagramComponent> | null = null;

export function loadDiagramRenderer(): Promise<DiagramComponent> {
    diagramComponent ??= import("./mermaid-diagram.tsx").then(
        (module) => module.default,
        // A failed chunk import degrades to the diagram source render instead
        // of an unhandled rejection; consumers keep the source visible.
        () =>
            memo(({ code }: { readonly code: string }) => (
                <MermaidSource code={code} message="Diagram could not be loaded. You can still copy its source." />
            )),
    );
    return diagramComponent;
}

function MermaidDiagramWhenReady({ code }: { readonly code: string }) {
    const [diagram, setDiagram] = useState<DiagramComponent | null>(null);
    useEffect(() => {
        let active = true;
        void loadDiagramRenderer().then((component) => {
            if (active) {
                setDiagram(() => component);
            }
        });
        return () => {
            active = false;
        };
    }, []);
    if (diagram === null) {
        return <MermaidSource code={code} message="Loading diagram…" />;
    }
    const Diagram = diagram;
    return <Diagram code={code} />;
}

export const MermaidCodeBlock = memo(function MermaidCodeBlock({ code, meta }: Readonly<CustomRendererProps>) {
    if (meta === INCOMPLETE_MERMAID_META) {
        return <MermaidSource code={code} message="Waiting for the diagram to finish…" />;
    }
    if (code.length > MAX_MERMAID_CHARACTERS) {
        return <MermaidSource code={code} message="Diagram is too large to display. You can still copy its source." />;
    }
    return <MermaidDiagramWhenReady code={code} />;
});
