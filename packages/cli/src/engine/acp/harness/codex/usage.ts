import type { AccountRateLimits, RateLimitResetCreditOutcome } from "./app-server-protocol.ts";

type RateLimitWindow = NonNullable<AccountRateLimits["rateLimits"]["primary"]>;

function windowLabel(minutes: number | null | undefined): string {
    if (minutes === null || minutes === undefined) {
        return "Usage limit";
    }
    if (minutes % 1_440 === 0) {
        return `${(minutes / 1_440).toString()}-day limit`;
    }
    if (minutes % 60 === 0) {
        return `${(minutes / 60).toString()}-hour limit`;
    }
    return `${minutes.toString()}-minute limit`;
}

function utcMinute(unixSeconds: number): string {
    const iso = new Date(unixSeconds * 1_000).toISOString();
    return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function windowLine(window: RateLimitWindow): string {
    const used = `- ${windowLabel(window.windowDurationMins)}: ${window.usedPercent.toString()}% used`;
    return window.resetsAt === null || window.resetsAt === undefined
        ? used
        : `${used}, resets ${utcMinute(window.resetsAt)}`;
}

function resetsLine(available: number): string {
    if (available === 0) {
        return "No usage limit resets available.";
    }
    const resets = available === 1 ? "1 usage limit reset" : `${available.toString()} usage limit resets`;
    return `${resets} available. Send /usage reset to use one.`;
}

export function usageReport(usage: AccountRateLimits): string {
    const windows = [usage.rateLimits.primary, usage.rateLimits.secondary].flatMap((window) =>
        window === null || window === undefined ? [] : [windowLine(window)],
    );
    const resets = usage.rateLimitResetCredits;
    const paragraphs = [
        ...(windows.length === 0 ? [] : [windows.join("\n")]),
        ...(resets === null || resets === undefined ? [] : [resetsLine(resets.availableCount)]),
    ];
    return paragraphs.length === 0 ? "Codex did not report usage limits." : paragraphs.join("\n\n");
}

export function usageResetReport(outcome: RateLimitResetCreditOutcome): string {
    switch (outcome) {
        case "reset":
        case "alreadyRedeemed":
            return "Codex usage limits were reset.";
        case "nothingToReset":
            return "Codex usage limits do not need a reset right now.";
        case "noCredit":
            return "No usage limit resets are available.";
    }
}
