import { getAllByRole, getByRole, getByText, queryByRole } from "@testing-library/dom";
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
    await app.user.keyboard("/c");
    const filtered = await app.waitForView(() => getByRole(document.body, "listbox", { name: "Commands" }));
    expect(getAllByRole(filtered, "option").map((option) => option.textContent)).toEqual([
        "/compactCompact the conversation context",
    ]);
    getByText(document.body, "1 command available");

    await app.user.keyboard("{Backspace}");
    const commands = await app.waitForView(() => {
        const list = getByRole(document.body, "listbox", { name: "Commands" });
        expect(getAllByRole(list, "option")).toHaveLength(2);
        return list;
    });
    getByText(document.body, "2 commands available");

    await app.user.hover(getByRole(commands, "option", { name: /usage/ }));
    await app.waitForView(() =>
        expect(
            getAllByRole(commands, "option", { selected: true }).map((option) => option.textContent?.slice(0, 6)),
        ).toEqual(["/usage"]),
    );
    await app.user.keyboard("{Enter}");
    await app.waitForView(() => {
        expect(composer).toHaveProperty("value", "/usage ");
        expect(queryByRole(document.body, "listbox", { name: "Commands" })).toBeNull();
    });
    expect(getByRole(document.body, "log", { name: "Messages" }).textContent).not.toContain("/usage");
});
