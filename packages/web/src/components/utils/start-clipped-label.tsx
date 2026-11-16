import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export function StartClippedLabel({
    value,
    clip = "start",
}: {
    readonly value: string;
    readonly clip?: "start" | "end";
}) {
    if (clip === "end") {
        return <span className="min-w-0 truncate">{value}</span>;
    }
    return <StartOverflowLabel value={value} />;
}

function StartOverflowLabel({ value }: { readonly value: string }) {
    const containerRef = useRef<HTMLSpanElement>(null);
    const [clipsStart, setClipsStart] = useState(false);

    // biome-ignore lint/correctness/useExhaustiveDependencies: remeasure start clipping when label text changes.
    useLayoutEffect(() => {
        const element = containerRef.current;
        if (element === null) {
            return;
        }
        const update = () => {
            setClipsStart(element.scrollWidth > element.clientWidth);
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(element);
        return () => {
            observer.disconnect();
        };
    }, [value]);

    return (
        <span
            className={cn(
                "min-w-0 flex-1 overflow-hidden whitespace-nowrap",
                clipsStart &&
                    "[-webkit-mask-image:linear-gradient(to_right,transparent,black_12px)] [mask-image:linear-gradient(to_right,transparent,black_12px)]",
            )}
            dir="rtl"
            ref={containerRef}
        >
            <span dir="ltr">{value}</span>
        </span>
    );
}
