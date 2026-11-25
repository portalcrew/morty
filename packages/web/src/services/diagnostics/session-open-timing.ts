type Outcome = "visible" | "empty" | "cancelled" | "hidden" | "timeout" | "failed";
type Progress =
    | { readonly stage: "opening" }
    | { readonly stage: "requested"; readonly request: number }
    | { readonly stage: "received"; readonly request: number; readonly response: number };

export const sessionOpenTimingPath = "/morty/api/v1/metrics/session-open";

const deadlineMs = 120_000;

export function startSessionOpenTiming(entry: "navigation" | "selection", opened: number) {
    if (
        document.visibilityState !== "visible" ||
        window.location.pathname !== "/chat" ||
        typeof IntersectionObserver === "undefined" ||
        navigator.doNotTrack === "1" ||
        ("globalPrivacyControl" in navigator && navigator.globalPrivacyControl === true)
    ) {
        return null;
    }
    const lifetime = new AbortController();
    let progress: Progress = { stage: "opening" };
    let historyIds: ReadonlySet<string> | undefined;
    let observer: IntersectionObserver | undefined;
    const elapsed = (at = performance.now()) => Math.min(deadlineMs, Math.max(0, Math.round(at - opened)));
    const finish = (outcome: Outcome, at = performance.now()): void => {
        if (lifetime.signal.aborted) {
            return;
        }
        lifetime.abort();
        window.clearTimeout(timer);
        observer?.disconnect();
        historyIds = undefined;
        const elapsedMs = elapsed(at);
        const sample = {
            entry,
            outcome: elapsedMs >= deadlineMs ? "timeout" : outcome,
            elapsedMs,
            openedToRequestMs: progress.stage === "opening" ? null : progress.request,
            requestToResponseMs: progress.stage === "received" ? progress.response - progress.request : null,
            responseToVisibleMs:
                outcome === "visible" && elapsedMs < deadlineMs && progress.stage === "received"
                    ? elapsedMs - progress.response
                    : null,
        };
        void fetch(sessionOpenTimingPath, {
            method: "POST",
            mode: "same-origin",
            redirect: "error",
            body: JSON.stringify(sample),
            headers: { "Content-Type": "application/json" },
            credentials: "omit",
            referrerPolicy: "origin",
            keepalive: true,
            signal: AbortSignal.timeout(5000),
        }).catch(() => undefined);
    };
    const timer = window.setTimeout(() => finish("timeout"), deadlineMs - elapsed());
    document.addEventListener(
        "visibilitychange",
        () => {
            if (document.hidden) {
                finish("hidden");
            }
        },
        { signal: lifetime.signal },
    );
    window.addEventListener("pagehide", () => finish("hidden"), { signal: lifetime.signal });
    const observe = (element: HTMLElement | null) => {
        if (element === null || lifetime.signal.aborted) {
            return;
        }
        observer ??= new IntersectionObserver((entries) => {
            if (document.visibilityState !== "visible") {
                return;
            }
            const visible = entries.find(
                (entry) =>
                    entry.target.isConnected &&
                    entry.isIntersecting &&
                    entry.intersectionRect.width > 0 &&
                    entry.intersectionRect.height > 0,
            );
            if (visible) {
                finish("visible", visible.time);
            }
        });
        observer.observe(element);
        return () => observer?.unobserve(element);
    };
    return {
        finish,
        request: () => {
            if (progress.stage === "opening") {
                progress = { stage: "requested", request: elapsed() };
            }
        },
        response: () => {
            if (progress.stage === "requested") {
                progress = { stage: "received", request: progress.request, response: elapsed() };
            }
        },
        history: (messages: readonly { readonly firstEvent: { readonly eventId: string } }[]) => {
            if (lifetime.signal.aborted) {
                return;
            }
            if (messages.length === 0) {
                finish("empty");
            } else {
                historyIds = new Set(messages.map((message) => message.firstEvent.eventId));
            }
        },
        messageRef: (id: string) => (historyIds?.has(id) ? observe : undefined),
    };
}

export type SessionOpenTiming = ReturnType<typeof startSessionOpenTiming>;
