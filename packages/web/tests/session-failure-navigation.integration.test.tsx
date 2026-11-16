import { getByRole, queryByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { openExecutionDetails, sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";

test("Given a saved-session link, When the bridge drops during entry initialization, Then execution details stop loading and Reconnect retries the same session", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock("2026-10-28T08:00:00Z");
    let dropped = false;
    let stopObserving = () => {};
    try {
        const app = await createTestApp({
            connectAgent: true,
            clock,
            page: { kind: "managed-session", harness: "claude", sessionId: "chat_unavailable_session" },
            prepare: (application) => {
                const observer = new MutationObserver(() => {
                    if (!dropped && queryByRole(document.body, "region", { name: "Conversation" }) !== null) {
                        dropped = true;
                        application.transport.disconnect();
                    }
                });
                observer.observe(document.body, { childList: true, subtree: true });
                stopObserving = () => observer.disconnect();
            },
        });
        await app.waitForView(() => getByRole(document.body, "button", { name: "Reconnect" }));
        expect(dropped).toBe(true);
        const details = await openExecutionDetails(app);
        expect(details.textContent).not.toContain("Loading…");
        expect(details.textContent).toContain("Unknown");
        await app.user.keyboard("{Escape}");

        await act(async () => {
            clock.advanceBy(1_000);
            app.transport.open();
        });
        await app.user.click(getByRole(document.body, "button", { name: "Reconnect" }));
        const failure = await app.queryElementByTestId(dataTestId.sessionLoadFailure);
        expect(failure.textContent).toContain("This session is not in Morty Recent sessions");
        expect(failure.textContent).toContain(
            'If you closed it in Morty, use "Open Session" to import or fork it again.',
        );
        expect(new URL(window.location.href).searchParams.get("sessionId")).toBe("chat_unavailable_session");
    } finally {
        stopObserving();
    }
});

test("Given an unavailable saved session, When opening it fails, Then navigation remains available and New Session lets the user send a new prompt", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        connectAgent: true,
        page: { kind: "managed-session", harness: "claude", sessionId: "chat_unavailable_session" },
    });
    await app.waitForView(() => getByRole(document.body, "button", { name: "Reconnect" }));
    expect(getByRole(document.body, "button", { name: "Open Session" })).toBeDefined();
    await app.user.click(getByRole(document.body, "button", { name: "New Session" }));
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    await sendPrompt(app, composer, "Continue in a new session");
    await app.waitForView(() =>
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
            "Codex turn 1: Continue in a new session",
        ),
    );
    expect(queryByRole(document.body, "button", { name: "Reconnect" })).toBeNull();
    expect(new URL(window.location.href).searchParams.get("sessionId")).not.toBe("chat_unavailable_session");
});
