import { Children, isValidElement, type ReactElement, type ReactNode } from "react";

function isScreenReaderOnly(child: ReactElement): boolean {
    const props: unknown = child.props;
    if (typeof props !== "object" || props === null || !("className" in props)) {
        return false;
    }
    const className: unknown = props.className;
    return typeof className === "string" && className.split(/\s+/).includes("sr-only");
}

function isIconChild(child: ReactNode): boolean {
    if (!isValidElement(child)) {
        return false;
    }
    const type = child.type;
    if (typeof type === "string") {
        return type === "svg";
    }
    return typeof type === "function" || typeof type === "object";
}

/**
 * Which edges carry an icon beside a label.
 * Whitespace text between JSX lines is ignored, so this still matches
 * `<Icon />\nLabel` where `svg:first-child` does not.
 */
export function buttonIconEdges(children: ReactNode): {
    readonly leading: boolean;
    readonly trailing: boolean;
} {
    const nodes = Children.toArray(children).filter((child) => {
        if (typeof child === "string") {
            return child.trim() !== "";
        }
        if (!isValidElement(child) || isScreenReaderOnly(child)) {
            return false;
        }
        return true;
    });
    if (nodes.length < 2) {
        return { leading: false, trailing: false };
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    return {
        leading: first !== undefined && isIconChild(first),
        trailing: last !== undefined && last !== first && isIconChild(last),
    };
}
