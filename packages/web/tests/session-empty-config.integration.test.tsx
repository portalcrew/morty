import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given a configured session, When the Agent removes every configurable option, Then the settings panel reflects the empty configuration", {
    timeout: 90_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement,
    );
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    const prompt = "Remove all settings";
    await sendPrompt(app, composer, prompt);
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes(prompt) === true),
        ).toBe(true),
    );

    // The panel starts with the harness model setting.
    const trigger = app.elementByTestId(dataTestId.agentConfiguration);
    expect(trigger.textContent).toContain("Test Small");

    // A held turn lets the harness push an explicit empty config update.
    await sendPrompt(app, composer, "hold after first delta");
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected the connected Agent Runtime");
    }
    await daemon.continueReply("hold after first delta", {
        outcome: "complete",
        output: [{ kind: "agent-config", configOptions: [] }],
    });

    // An explicit empty config_option_update is real agent state: the panel
    // must clear instead of retaining the removed options.
    await app.waitForView(
        () => expect(app.elementByTestId(dataTestId.agentConfiguration).textContent).not.toContain("Test Small"),
        30_000,
    );
});
