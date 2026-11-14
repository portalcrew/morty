import { useId } from "react";
import { MortyLogoMark } from "@/components/brand/morty-logo";
import { HarnessMark } from "@/components/chat/harness-mark";
import { cn } from "@/lib/utils";

/** Soft gradient artwork painted inside the setup connection arc. */
const setupConnectionBandArtworkUrl = "/setup-connection-band.png";

/** Plate and glyph both use 70% opacity; icons were full `#171717` so they did not follow `bg-white/*` alone. */
const setupHarnessTileClassName =
    "absolute top-6 flex size-11 -translate-x-1/2 items-center justify-center rounded-[14px] bg-white/70";
const setupHarnessMarkClassName = "text-[#171717]/70";

/**
 * The harnesses that can connect to Morty, laid over a band that curves toward
 * the Morty mark. The clip path needs a per-instance id, so this stays a
 * component rather than markup a view inlines.
 */
export function SetupConnectionGraphic() {
    const bandClipId = `setup-connection-band-${useId().replaceAll(":", "")}`;
    return (
        <figure
            aria-label="Codex, Claude Code, and Pi connect to Morty"
            className="relative -mt-10 mb-6 h-[140px] w-[calc(100%+4rem)] shrink-0"
        >
            <svg
                aria-hidden="true"
                className="absolute inset-0 size-full"
                fill="none"
                preserveAspectRatio="none"
                viewBox="0 0 400 140"
            >
                <defs>
                    <clipPath id={bandClipId}>
                        <path d="M0 0H400V72C278 126 122 126 0 72Z" />
                    </clipPath>
                </defs>
                <image
                    clipPath={`url(#${bandClipId})`}
                    height="140"
                    href={setupConnectionBandArtworkUrl}
                    preserveAspectRatio="none"
                    width="400"
                />
                <path
                    d="M400 72C278 126 122 126 0 72"
                    stroke="var(--morty-fill-white)"
                    strokeLinecap="round"
                    strokeWidth="1"
                />
            </svg>
            <span aria-hidden="true" className={cn(setupHarnessTileClassName, "left-[30%]")}>
                <HarnessMark harness="codex" className={cn(setupHarnessMarkClassName, "size-[20px]")} label="Codex" />
            </span>
            <span aria-hidden="true" className={cn(setupHarnessTileClassName, "left-1/2")}>
                <HarnessMark
                    harness="claude"
                    className={cn(setupHarnessMarkClassName, "size-[18px]")}
                    label="Claude Code"
                />
            </span>
            <span aria-hidden="true" className={cn(setupHarnessTileClassName, "left-[70%]")}>
                <HarnessMark
                    harness="pi"
                    className={cn(setupHarnessMarkClassName, "size-[14px] rounded-none [&>svg]:size-[14px]")}
                    label="Pi"
                />
            </span>
            <span
                aria-hidden="true"
                className="absolute top-[77px] left-1/2 flex size-[70px] -translate-x-1/2 items-center justify-center rounded-[22px] border-[1px] border-white bg-card shadow-[0_4px_16px_rgba(23,30,36,0.12)]"
            >
                <MortyLogoMark size={45} />
            </span>
        </figure>
    );
}
