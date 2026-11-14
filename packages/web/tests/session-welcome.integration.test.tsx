import { getByRole, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { readyComposer } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

async function openFirstSession() {
    const sessionId = "first-session-guidance";
    const app = await createTestApp({
        agent: { harness: "pi", label: "Pi" },
        connectAgent: true,
        sessionIds: new Set([sessionId]),
        page: { harness: "pi", kind: "continue", sessionId },
    });
    await app.waitForView(() => expect(window.location.pathname).toBe("/chat"));
    return await app.reload();
}

test("Given a first session handoff, When the original session opens, Then a dismissible tip helps me continue without sending a message", {
    timeout: 30_000,
}, async () => {
    const app = await openFirstSession();
    const tip = await app.waitForView(() => getByRole(document.body, "region", { name: "Continue your work here" }));
    expect(tip.textContent).toContain("Your original session is open.");
    expect(app.elementsByTestId(dataTestId.userMessage)).toHaveLength(0);
    await app.user.click(getByRole(tip, "button", { name: "Dismiss getting started tip" }));
    expect(queryByRole(document.body, "region", { name: "Continue your work here" })).toBeNull();

    const reloaded = await app.reload();
    await readyComposer(reloaded);
    expect(queryByRole(document.body, "region", { name: "Continue your work here" })).toBeNull();
});

test("Given the first-session tip, When I choose a progress question, Then it becomes an editable draft and is sent only after I press Send", {
    timeout: 30_000,
}, async () => {
    const app = await openFirstSession();
    await app.user.click(
        await app.waitForView(() => getByRole(document.body, "button", { name: "Ask for a progress update" })),
    );
    const composer = getByRole(document.body, "textbox", { name: "Message" });
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected an editable message draft");
    }
    expect(composer.value).toBe("Summarize the current task's progress and anything that needs my attention.");
    expect(app.elementsByTestId(dataTestId.userMessage)).toHaveLength(0);
    expect(queryByRole(document.body, "region", { name: "Continue your work here" })).toBeNull();
    await app.user.click(composer);
    await app.user.clear(composer);
    await app.user.paste("Tell me the current progress.");
    await app.user.click(getByRole(document.body, "button", { name: "Send message" }));
    await app.waitForView(() => expect(app.elementsByTestId(dataTestId.userMessage)).toHaveLength(1));
    expect((await app.queryElementByTestId(dataTestId.userMessage)).textContent).toContain(
        "Tell me the current progress.",
    );
});

test("Given I have started writing my own instruction, When I send it, Then the tip preserves my draft and gets out of the way", {
    timeout: 30_000,
}, async () => {
    const app = await openFirstSession();
    await app.waitForView(() => getByRole(document.body, "region", { name: "Continue your work here" }));
    const composer = getByRole(document.body, "textbox", { name: "Message" });
    await app.user.click(composer);
    await app.user.paste("Keep my own instruction");
    expect(queryByRole(document.body, "button", { name: "Ask for a progress update" })).toBeNull();
    expect(composer).toHaveProperty("value", "Keep my own instruction");
    await app.user.click(getByRole(document.body, "button", { name: "Send message" }));
    await app.waitForView(() =>
        expect(queryByRole(document.body, "region", { name: "Continue your work here" })).toBeNull(),
    );
});
