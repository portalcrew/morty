import { getByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { openAgentModelPicker, readyComposer, sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

async function openConfiguredConversation(app: TestApp, reply: string): Promise<void> {
    const composer = await readyComposer(app);
    await sendPrompt(app, composer, "Keep my selected model");
    await app.waitForView(() =>
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(reply),
    );
    await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
    await openAgentModelPicker(app);
    await app.user.click(await app.queryElementByTestId(dataTestId.sessionConfigValue("test-large")));
    await app.user.keyboard("{Escape}");
    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.agentConfiguration).textContent).toContain("Test Large"),
    );
}

test("Given a configured conversation, When the Agent explicitly removes every setting, Then the configuration clears", {
    timeout: 60_000,
}, async () => {
    const app = await createTestApp({
        connectAgent: true,
        agent: { harness: "settings-test", label: "Settings Agent" },
    });
    await app.queryElementByTestId(
        dataTestId.agentConfiguration,
        (element) => element.textContent?.includes("Test Small") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    await sendPrompt(app, composer, "Remove settings");
    await app.waitForView(() =>
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain("Settings removed"),
    );
    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.agentConfiguration).textContent).not.toContain("Test Small"),
    );
});

test("Given a configured conversation, When the user reopens it, Then the conversation is ready with its model", {
    timeout: 60_000,
}, async () => {
    const app = await createTestApp({
        connectAgent: true,
        agent: { harness: "settings-test", label: "Settings Agent" },
    });
    await openConfiguredConversation(app, "Settings Agent: Keep my selected model");

    const reloaded = await app.reload();
    const composer = await readyComposer(reloaded);
    expect(reloaded.elementByTestId(dataTestId.agentConfiguration).textContent).toContain("Test Large");
    await sendPrompt(reloaded, composer, "Continue on this Computer");
    await reloaded.waitForView(() =>
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
            "Settings Agent: Continue on this Computer",
        ),
    );
    expect(reloaded.elementByTestId(dataTestId.agentConfiguration).textContent).toContain("Test Large");
});

test("Given the Agent changed its model during a turn and the user then picked another, When the user reopens the conversation, Then it shows and keeps the model the user picked", {
    timeout: 60_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    if (app.daemon === null) {
        throw new Error("Expected the connected Computer");
    }
    const composer = await readyComposer(app);
    // The Agent switches its own model during a turn, as Claude Code does on entering plan mode.
    await sendPrompt(app, composer, "hold after first delta");
    await app.daemon.continueReply("hold after first delta", {
        outcome: "complete",
        output: [
            {
                kind: "agent-config",
                configOptions: [
                    {
                        category: "model",
                        currentValue: "test-large",
                        id: "model",
                        name: "Model",
                        options: [
                            { name: "Test Small", value: "test-small" },
                            { name: "Test Large", value: "test-large" },
                        ],
                        type: "select",
                    },
                ],
            },
        ],
    });
    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.agentConfiguration).textContent).toContain("Test Large"),
    );
    await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
    await openAgentModelPicker(app);
    await app.user.click(await app.queryElementByTestId(dataTestId.sessionConfigValue("test-small")));
    await app.user.keyboard("{Escape}");
    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.agentConfiguration).textContent).toContain("Test Small"),
    );

    const reloaded = await app.reload();
    // The history, which still records the Agent's own switch, has loaded.
    await reloaded.waitForView(() =>
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain("hold after first delta"),
    );
    expect(reloaded.elementByTestId(dataTestId.agentConfiguration).textContent).toContain("Test Small");
});
