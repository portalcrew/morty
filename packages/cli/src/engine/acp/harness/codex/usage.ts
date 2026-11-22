import type { AccountRateLimits, CodexTurnError, RateLimitResetCreditOutcome } from "./app-server-protocol.ts";

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

const localTimeOptions: Intl.DateTimeFormatOptions = {
    day: "numeric",
    hour: "numeric",
    hour12: true,
    minute: "2-digit",
    month: "short",
    year: "numeric",
};

function localTimeFormat(timeZone: string | undefined): Intl.DateTimeFormat {
    try {
        return new Intl.DateTimeFormat("en-US", { ...localTimeOptions, timeZone });
    } catch (error) {
        if (!(error instanceof RangeError)) {
            throw error;
        }
        return new Intl.DateTimeFormat("en-US", localTimeOptions);
    }
}

function daySuffix(day: number): string {
    if (day >= 11 && day <= 13) {
        return "th";
    }
    return day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th";
}

// Matches how Codex itself writes a reset time, such as "Nov 21st, 2026 3:00 PM", so its limit message agrees.
function localTime(unixSeconds: number, timeZone: string | undefined): string {
    const parts = localTimeFormat(timeZone).formatToParts(new Date(unixSeconds * 1_000));
    const part = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find((entry) => entry.type === type)?.value ?? "";
    const day = Number(part("day"));
    return `${part("month")} ${day.toString()}${daySuffix(day)}, ${part("year")} ${part("hour")}:${part("minute")} ${part("dayPeriod")}`;
}

function windowLine(window: RateLimitWindow, timeZone: string | undefined): string {
    const used = `- ${windowLabel(window.windowDurationMins)}: ${window.usedPercent.toString()}% used`;
    return window.resetsAt === null || window.resetsAt === undefined
        ? used
        : `${used}, resets ${localTime(window.resetsAt, timeZone)}`;
}

function resetsLine(available: number): string {
    if (available === 0) {
        return "No usage limit resets available.";
    }
    const resets = available === 1 ? "1 usage limit reset" : `${available.toString()} usage limit resets`;
    return `${resets} available. Send /usage reset to use one.`;
}

export function usageReport(usage: AccountRateLimits, timeZone: string | undefined): string {
    const windows = [usage.rateLimits.primary, usage.rateLimits.secondary].flatMap((window) =>
        window === null || window === undefined ? [] : [windowLine(window, timeZone)],
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
            return "No usage limit resets available.";
    }
}

export function turnFailureMessage(error: CodexTurnError | null | undefined): string {
    const message = error?.message ?? "The Codex turn failed";
    return error?.codexErrorInfo === "usageLimitExceeded"
        ? `${message}\n\nSend /usage to see your usage limits and resets, or /usage reset to use one.`
        : message;
}
