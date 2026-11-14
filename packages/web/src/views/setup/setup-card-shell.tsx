import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { MortyLogoMark } from "@/components/brand/morty-logo";
import { cn } from "@/lib/utils";
import { overlaySurfaceRadiusClassName } from "../../components/ui/overlay-surface.ts";

const setupPageBackgroundClassName = "bg-[radial-gradient(circle_at_top,_#f6f7f9_0%,_#f0f1f4_48%)]";

const setupSectionClassName = "mx-auto w-full max-w-[460px]";

const setupCardClassName = `flex flex-col items-center overflow-hidden ${overlaySurfaceRadiusClassName} border-[1px] border-white bg-card px-8 pt-10 pb-6 text-center shadow-module backdrop-blur`;

/** Vertical rhythm below title or description (24px top, 12px between children). */
const setupContentStackClassName = "mt-6 w-full space-y-3";

/** Full-width setup actions; pair with `setupPrimaryButtonSize` on cloud `Button`. */
export const setupPrimaryButtonClassName = "w-full !rounded-[24px]";

export const setupPrimaryButtonSize = "lg" as const;

/** Primary heading on setup card surfaces (`SetupCardShell`). */
const setupCardTitleClassName = "max-w-md text-24 font-semibold tracking-[-0.03em]";

function SetupPageHeader({ headerAction }: { readonly headerAction: ReactNode }) {
    return (
        <header className="w-full shrink-0">
            <div className="flex min-h-16 w-full items-center justify-between px-4 py-3 sm:px-6">
                <a
                    className="flex items-center gap-2 text-16 font-semibold tracking-tight"
                    href="/"
                    aria-label="Morty home"
                >
                    <MortyLogoMark size={28} />
                    Morty
                </a>
                {headerAction}
            </div>
        </header>
    );
}

/** Top logo bar plus a centered content column; pairs with a single card section surface. */
function SetupPageWithHeader({
    children,
    headerAction,
    pageAction,
    pageFooter,
    pageNotice,
}: {
    readonly children: ReactNode;
    readonly headerAction?: ReactNode;
    readonly pageAction?: ReactNode;
    readonly pageFooter?: ReactNode;
    readonly pageNotice?: ReactNode;
}) {
    const hasPageLeading = pageNotice !== undefined || pageAction !== undefined;
    return (
        <main className={`flex min-h-dvh flex-col overflow-y-auto ${setupPageBackgroundClassName} text-foreground`}>
            <SetupPageHeader headerAction={headerAction} />
            {pageNotice !== undefined && <div className="w-full px-6">{pageNotice}</div>}
            <div
                className={
                    hasPageLeading
                        ? "flex flex-1 flex-col items-center justify-center px-6 py-6"
                        : "flex flex-1 flex-col items-center px-6 md:justify-center md:py-12"
                }
            >
                {pageAction !== undefined && <div className="mb-6">{pageAction}</div>}
                {/* Mobile: the gap above the card is 40% of the space left after the header and card. */}
                {!hasPageLeading && <div aria-hidden="true" className="grow-[40] basis-0 md:hidden" />}
                {children}
                {!hasPageLeading && <div aria-hidden="true" className="grow-[60] basis-0 md:hidden" />}
            </div>
            {pageFooter}
        </main>
    );
}

export function SetupCardFailureIcon() {
    return (
        <span className="mb-6 flex size-12 items-center justify-center rounded-full bg-destructive/5">
            <CircleAlert aria-hidden="true" className="size-6 shrink-0 text-destructive" />
        </span>
    );
}

export function SetupCardTitle({
    id,
    children,
    className = "",
}: {
    readonly id: string;
    readonly children: ReactNode;
    readonly className?: string;
}) {
    return (
        <h1 id={id} className={cn(setupCardTitleClassName, className)}>
            {children}
        </h1>
    );
}

export function SetupCardDescription({
    children,
    className = "",
}: {
    readonly children: ReactNode;
    readonly className?: string;
}) {
    return <p className={`mt-2 max-w-xl text-16 leading-[26px] text-morty-text-2 ${className}`}>{children}</p>;
}

export function SetupCardAlert({ children }: { readonly children: ReactNode }) {
    return (
        <p role="alert" className="mt-2 max-w-xl text-16 leading-[26px] text-morty-text-2">
            {children}
        </p>
    );
}

export function SetupCardSection({
    children,
    className = "",
}: {
    readonly children: ReactNode;
    readonly className?: string;
}) {
    return <div className={cn(setupContentStackClassName, className)}>{children}</div>;
}

export function SetupCardShell({
    cardClassName = "",
    cardLeading,
    headerAction,
    pageAction,
    pageFooter,
    pageNotice,
    titleId,
    children,
}: {
    readonly cardClassName?: string;
    readonly cardLeading?: ReactNode;
    readonly headerAction?: ReactNode;
    readonly pageAction?: ReactNode;
    /** Content below the card. */
    readonly pageFooter?: ReactNode;
    readonly pageNotice?: ReactNode;
    readonly titleId: string;
    readonly children: ReactNode;
}) {
    return (
        <SetupPageWithHeader
            headerAction={headerAction}
            pageAction={pageAction}
            pageFooter={pageFooter}
            pageNotice={pageNotice}
        >
            <section aria-labelledby={titleId} className={cn(setupSectionClassName, setupCardClassName, cardClassName)}>
                {cardLeading}
                {children}
            </section>
        </SetupPageWithHeader>
    );
}
