import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { openAgentModelPicker, sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";
import { createChatWorkerEnvironment } from "./support/chat-worker.ts";

test("Given an old setting edit response in flight, When another client changes the model, Then releasing the old response preserves the current model", {
    timeout: 60000,
}, async ({ signal }) => {
    const environment = await createChatWorkerEnvironment(true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({
        environment,
        connectAgent: true,
        agent: { harness: "settings-test", label: "Settings Agent" },
    });
    const network = app.network;
    if (!network || !app.daemon) {
        throw new Error("Missing real network or Computer");
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Start shared session");
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Start shared session");
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
    });
    const sessionId = new URL(window.location.href).searchParams.get("sessionId");
    if (!sessionId) {
        throw new Error("Missing session");
    }
    await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
    await openAgentModelPicker(app);
    const held = network.holdNextConfigurationResponse();
    await app.user.click(await app.queryElementByTestId(dataTestId.sessionConfigValue("test-large")));
    await app.user.keyboard("{Escape}");
    await held;
    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.agentConfiguration).textContent).toContain("Test Large"),
    );
    await app.daemon.selectModel(sessionId, "test-small", signal);
    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.agentConfiguration).textContent).toContain("Test Small"),
    );
    network.releaseConfigurationResponse();
    await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
    await app.queryElementByTestId(
        dataTestId.agentSetting("model"),
        (element) => element instanceof HTMLButtonElement && !element.disabled,
    );
    const displayedAfterResponse = app.elementByTestId(dataTestId.agentConfiguration).textContent;
    await app.user.keyboard("{Escape}");
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Report current model");
    await app.waitForView(() =>
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain(
            "Current model: test-small",
        ),
    );
    expect(displayedAfterResponse).toContain("Test Small");
});
