import { SquareTerminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { dataTestId } from "../../data-testid.ts";

export type HarnessProduct = "claude" | "codex" | "pi" | "generic";

// Brand marks are inlined rather than pulled from a package so that a harness
// can only render a mark the build actually ships. `harness` is an identifier,
// never a display string, so identity is matched exactly before the label is
// consulted as a fallback.
const HARNESS_PRODUCTS: readonly { readonly harnesses: readonly string[]; readonly product: HarnessProduct }[] = [
    { harnesses: ["claude", "claude-code"], product: "claude" },
    { harnesses: ["codex", "openai"], product: "codex" },
    { harnesses: ["pi"], product: "pi" },
];

// Paths are transcribed from each product's published logo and must stay
// faithful to it: a plausible-looking invented glyph still reads to a user as
// that product's real mark. Marks are the mono glyphs used beside model
// names: currentColor, with no colored tile.
const CLAUDE_LINE_PATH =
    "m240.004 659.672l176.117-98.825l2.949-8.613l-2.95-4.76h-8.612l-29.467-1.814l-100.636-2.722l-87.267-3.625l-84.545-4.532l-21.306-4.536l-19.947-26.29l2.038-13.15l17.909-12.013l25.61 2.27l56.669 3.853l84.997 5.89l61.652 3.63l91.347 9.52h14.508l2.038-5.895l-4.987-3.625l-3.853-3.63l-87.943-59.61l-95.2-63.014l-49.862-36.266l-26.973-18.36l-13.6-17.226l-5.892-37.624l24.48-26.974l32.864 2.266l8.385 2.266l33.32 25.611l71.172 55.082l92.934 68.454l13.6 11.33l5.44-3.852l.68-2.718l-6.123-10.203l-50.546-91.344l-53.946-92.933l-24.024-38.528l-6.347-23.125c-2.266-9.52-3.853-17.45-3.853-27.197l27.88-37.856L314.123 64l37.173 4.988l15.643 13.597l23.116 52.815l37.4 83.186l58.028 113.105l16.998 33.544l9.068 31.054l3.398 9.52h5.894v-5.44l4.76-63.69l8.841-78.202l8.613-100.64L546 129.505l14.053-34l27.88-18.36l21.758 10.427l17.909 25.61l-2.494 16.55l-10.651 69.13L593.6 307.208L580 379.743h7.933l9.068-9.068l36.718-48.732l61.652-77.067l27.201-30.598l31.733-33.772l20.4-16.094h38.531l28.336 42.16l-12.693 43.52l-39.667 50.318l-32.868 42.612l-47.145 63.467l-29.467 50.773l2.722 4.08l7.026-.683l106.53-22.661l57.572-10.431l68.679-11.786l31.054 14.508l3.397 14.731l-12.238 30.147l-73.435 18.133l-86.135 17.225L656.61 540.9l-1.587 1.135l1.814 2.266l57.8 5.44l24.707 1.358h60.517l112.654 8.389l29.463 19.488l17.681 23.804l-2.95 18.132l-45.33 23.121l-61.2-14.508l-142.8-34l-48.955-12.24h-6.802v4.08l40.801 39.894l74.798 67.544l93.613 87.039l4.76 21.533l-12.014 17.002l-12.693-1.814l-82.279-61.88l-31.733-27.88l-71.852-60.518h-4.76v6.346l16.546 24.252l87.494 131.466l4.533 40.346l-6.347 13.145l-22.665 7.933l-24.935-4.532l-51.225-71.852l-52.812-80.92l-42.612-72.53l-5.215 2.948l-25.163 270.861l-11.783 13.825L488.88 960l-22.666-17.226l-12.014-27.88l12.014-55.078l14.508-71.852l11.786-57.12l10.651-70.948l6.347-23.572l-.452-1.587l-5.215.68l-53.491 73.442l-81.372 109.931l-64.374 68.903l-15.411 6.122l-26.746-13.828l2.49-24.707l14.964-21.986l89.077-113.332l53.719-70.262l34.683-40.574l-.232-5.895h-2.038L218.47 756.911l-42.16 5.439l-18.133-17.002l2.27-27.877l8.613-9.068l71.172-48.959Z";

const CODEX_LINE_PATHS = [
    "M11.745 14.85L6.905 12V7c0-2.21 1.824-4 4.076-4c1.397 0 2.63.69 3.365 1.741",
    "M9.6 19.18A4.1 4.1 0 0 0 13.02 21c2.25 0 4.076-1.79 4.076-4v-5L12.16 9.097",
    "M9.452 13.5V7.67l4.412-2.5c1.95-1.105 4.443-.45 5.569 1.463a3.93 3.93 0 0 1 .076 3.866",
    "M4.49 13.5a3.93 3.93 0 0 0 .075 3.866c1.126 1.913 3.62 2.568 5.57 1.464l4.412-2.5l.096-5.596",
    "M17.096 17.63a4.09 4.09 0 0 0 3.357-1.996c1.126-1.913.458-4.36-1.492-5.464l-4.413-2.5l-5.059 2.755",
    "M6.905 6.37a4.09 4.09 0 0 0-3.358 1.996c-1.126 1.914-.458 4.36 1.492 5.464l4.413 2.5l5.048-2.75",
] as const;

const PI_PATH = "M0 0v24h6v-6h6v-6H6V6h6v6h6V0Zm18 12v12h6V12Z";

function identifyHarnessProduct(harness: string, label: string): HarnessProduct {
    const identity = harness.toLowerCase();
    const exact = HARNESS_PRODUCTS.find((entry) => entry.harnesses.includes(identity));
    if (exact !== undefined) {
        return exact.product;
    }
    const guess = label.toLowerCase();
    if (guess.includes("claude")) {
        return "claude";
    }
    if (guess.includes("codex") || guess.includes("openai")) {
        return "codex";
    }
    return "generic";
}

export function HarnessMark({
    harness,
    className,
    label,
    loading = false,
    testId,
}: {
    readonly harness: string;
    readonly className?: string;
    readonly label: string;
    readonly loading?: boolean;
    readonly testId?: string;
}) {
    if (loading) {
        return (
            <span
                aria-hidden="true"
                className={cn("inline-flex size-4 shrink-0 items-center justify-center", className)}
                data-testid={testId}
            >
                {/* The mark occupies the same footprint the loaded glyph will, so settling does not move the title. */}
                <span
                    className="size-full animate-pulse rounded-[4px] bg-muted motion-reduce:animate-none"
                    data-testid={dataTestId.harnessMarkSkeleton}
                />
            </span>
        );
    }
    const product = identifyHarnessProduct(harness, label);
    if (product === "codex") {
        return (
            <svg
                aria-hidden="true"
                className={cn("size-[17px] shrink-0", className)}
                data-harness-product={product}
                data-testid={testId}
                fill="none"
                viewBox="0 0 24 24"
            >
                <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5">
                    {CODEX_LINE_PATHS.map((d) => (
                        <path d={d} key={d} />
                    ))}
                </g>
            </svg>
        );
    }
    if (product === "claude") {
        return (
            <svg
                aria-hidden="true"
                className={cn("size-4 shrink-0", className)}
                data-harness-product={product}
                data-testid={testId}
                fill="none"
                viewBox="0 0 1024 1024"
            >
                <path d={CLAUDE_LINE_PATH} fill="currentColor" />
            </svg>
        );
    }
    return (
        <span
            aria-hidden="true"
            className={cn("inline-flex size-5 shrink-0 items-center justify-center text-current", className)}
            data-harness-product={product}
            data-testid={testId}
        >
            {product === "pi" ? (
                <svg aria-hidden="true" className="size-[12px]" fill="currentColor" viewBox="0 0 24 24">
                    <path d={PI_PATH} />
                </svg>
            ) : (
                <SquareTerminal aria-hidden="true" className="size-[12px]" />
            )}
        </span>
    );
}
