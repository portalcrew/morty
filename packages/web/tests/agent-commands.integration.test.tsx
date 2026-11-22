import { getAllByRole, getByRole, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { readyComposer, sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";

test("Given an Agent reports its commands, When I type / in a conversation and choose one, Then the command fills the message box without sending", async () => {
    const app = await createTestApp({
        connectAgent: true,
        agent: {
            harness: "claude",
            label: "Claude Code",
            commands: [
                { name: "compact", description: "Compact the conversation context" },
                { name: "usage", description: "Show usage limits and resets", input: { hint: "reset" } },
            ],
        },
        clock: new TestClock("2026-11-22T08:00:00Z"),
    });
    await sendPrompt(app, await readyComposer(app), "Hello");
    await app.waitForView(() => getByRole(document.body, "article", { name: "Agent response" }));
    const composer = await readyComposer(app);

    await app.user.click(composer);
    await app.user.keyboard("/us");
    const commands = await app.waitForView(() => getByRole(document.body, "listbox", { name: "Commands" }));
    expect(getAllByRole(commands, "option").map((option) => option.textContent)).toEqual([
        "/usageresetShow usage limits and resets",
    ]);

    await app.user.click(getByRole(commands, "option", { name: /usage/ }));
    await app.waitForView(() => {
        expect(composer).toHaveProperty("value", "/usage ");
        expect(queryByRole(document.body, "listbox", { name: "Commands" })).toBeNull();
    });
    expect(getByRole(document.body, "log", { name: "Messages" }).textContent).not.toContain("/usage");
});
