import { getByRole, queryByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { readyComposer, refreshSessions, sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";
import { createChatWorkerEnvironment, dedicatedEnvironmentTimeout } from "./support/chat-worker.ts";

test("Given a running conversation, When I switch to another conversation and the background reply completes, Then its spinner automatically becomes unread without disturbing my draft", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock("2026-11-17T08:00:00Z");
    const app = await createTestApp({ connectAgent: true, clock });
    if (app.daemon === null) {
        throw new Error("Expected the connected Computer");
    }
    await sendPrompt(app, await readyComposer(app), "hold after first delta");
    const background = await app.waitForView(() => {
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain("Partial reply");
        const entry = getByRole(document.body, "button", { name: "Open hold after first delta" });
        expect(getByRole(entry, "status", { name: "Session working" })).toBeDefined();
        return entry;
    });
    await app.user.click(getByRole(document.body, "button", { name: "New Session" }));
    await sendPrompt(app, await readyComposer(app), "Other conversation");
    await app.waitForView(() =>
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
            "Codex turn 1: Other conversation",
        ),
    );
    const composer = await readyComposer(app);
    await app.user.click(composer);
    await app.user.paste("Keep my next draft");
    await app.daemon.continueReply("hold after first delta", {
        outcome: "complete",
        output: [{ kind: "text", text: "Finished in the background" }],
    });
    await act(async () => clock.advanceBy(5_000));
    await app.waitForView(() => getByRole(background, "status", { name: "Unread response" }));
    expect(composer).toHaveProperty("value", "Keep my next draft");
    expect(getByRole(document.body, "button", { name: "Open Other conversation" }).getAttribute("aria-current")).toBe(
        "page",
    );
    await app.user.click(background);
    await app.waitForView(() => {
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
            "Finished in the background",
        );
        expect(queryByRole(background, "status")).toBeNull();
    });
});

test("Given two Sessions and I am viewing one, When a turn started elsewhere runs and ends in the other before the sidebar lists it again, Then the refreshed sidebar marks the other Session unread", {
    timeout: 30_000,
}, async ({ signal }) => {
    const clock = new TestClock("2026-11-17T08:00:00Z");
    const app = await createTestApp({ connectAgent: true, clock });
    if (app.daemon === null) {
        throw new Error("Expected the connected Computer");
    }
    await sendPrompt(app, await readyComposer(app), "Conversation left idle");
    await app.waitForView(() => {
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
            "Codex turn 1: Conversation left idle",
        );
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
    });
    const sessionId = new URL(window.location.href).searchParams.get("sessionId");
    if (sessionId === null) {
        throw new Error("Expected the open Session");
    }
    await app.user.click(getByRole(document.body, "button", { name: "New Session" }));
    await sendPrompt(app, await readyComposer(app), "Conversation I am reading");
    const other = await app.waitForView(() => {
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
            "Codex turn 1: Conversation I am reading",
        );
        const entry = getByRole(document.body, "button", { name: "Open Conversation left idle" });
        expect(queryByRole(entry, "status")).toBeNull();
        return entry;
    });

    await app.daemon.runTurn(sessionId, "Continue from another device", signal);
    await refreshSessions(app);

    await app.waitForView(() => getByRole(other, "status", { name: "Unread response" }));
    await app.user.click(other);
    await app.waitForView(() => {
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
            "Codex turn 2: Continue from another device",
        );
        expect(queryByRole(other, "status")).toBeNull();
    });
});

test("Given a message still on its way to the Computer, When I switch conversations, Then the sidebar keeps it working instead of marking an unread reply", {
    timeout: dedicatedEnvironmentTimeout,
}, async () => {
    const clock = new TestClock("2026-11-17T08:00:00Z");
    const environment = await createChatWorkerEnvironment(false, true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true, clock });
    const { executionNetwork } = app;
    if (app.daemon === null || executionNetwork === null) {
        throw new Error("Expected the Computer and its controlled network");
    }
    await sendPrompt(app, await readyComposer(app), "Pending submission");
    await app.waitForView(() => {
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
            "Codex turn 1: Pending submission",
        );
        expect(queryByRole(document.body, "status", { name: "Session working" })).toBeNull();
    });
    const submitted = executionNetwork.holdNextSubmission();
    await sendPrompt(app, await readyComposer(app), "hold after first delta");
    const release = await submitted;
    onTestFinished(release);
    await app.user.click(getByRole(document.body, "button", { name: "New Session" }));
    await sendPrompt(app, await readyComposer(app), "Other while sending");
    await app.waitForView(() => {
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
            "Codex turn 1: Other while sending",
        );
        getByRole(document.body, "button", { name: "Refresh sessions" });
    });
    const background = getByRole(document.body, "button", { name: "Open Pending submission" });
    expect(getByRole(background, "status", { name: "Session working" })).toBeDefined();
    release();
});
