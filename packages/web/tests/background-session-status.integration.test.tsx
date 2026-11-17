import { getByRole, queryByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, test } from "vitest";
import { readyComposer, sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";

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
