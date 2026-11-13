import { getByRole } from "@testing-library/dom";
import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { openAgentModelPicker, sendPrompt, showReconnectNotice } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";
import { createChatWorkerEnvironment, dedicatedEnvironmentTimeout } from "./support/chat-worker.ts";

test("Given two clients of the current Computer, When one changes the model and the other sends, Then the Session keeps the explicit choice", {
    timeout: 60_000,
}, async () => {
    const first = await createTestApp({
        connectAgent: true,
        agent: { harness: "settings-test", label: "Settings Agent" },
    });
    await sendPrompt(first, await first.queryElementByTestId(dataTestId.messageComposer), "Start shared session");
    await first.waitForView(() => {
        expect(first.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Start shared session");
        expect(first.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
    });
    const second = await first.openViewer();
    await second.queryElementByTestId(
        dataTestId.agentConfiguration,
        (element) => element.textContent?.includes("Test Small") === true,
    );

    await first.user.click(await first.queryElementByTestId(dataTestId.agentConfiguration));
    await openAgentModelPicker(first);
    await first.user.click(await first.queryElementByTestId(dataTestId.sessionConfigValue("test-large")));
    await first.user.keyboard("{Escape}");
    await first.waitForView(() =>
        expect(first.elementByTestId(dataTestId.agentConfiguration).textContent).toContain("Test Large"),
    );
    // A settings response without an ACP notification must still reach the other viewer.
    await second.waitForView(() =>
        expect(second.elementByTestId(dataTestId.agentConfiguration).textContent).toContain("Test Large"),
    );
    await sendPrompt(second, await second.queryElementByTestId(dataTestId.messageComposer), "Report current model");
    await second.waitForView(() =>
        expect(second.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain(
            "Current model: test-large",
        ),
    );
});

for (const delivery of ["before-acceptance", "after-acceptance"] as const) {
    test(`Given delivery is unknown ${delivery}, When settings change and I recover, Then retries preserve intent and completed turns are not rerun`, {
        timeout: dedicatedEnvironmentTimeout,
    }, async () => {
        const environment = await createChatWorkerEnvironment(true);
        onTestFinished(() => environment.close());
        const clock = new TestClock("2026-10-28T08:00:00Z");
        const first = await createTestApp({
            clock,
            environment,
            connectAgent: true,
            agent: { harness: "settings-test", label: "Settings Agent" },
        });
        const network = first.network;
        if (network === null) {
            throw new Error("Expected the response-loss network");
        }
        await sendPrompt(first, await first.queryElementByTestId(dataTestId.messageComposer), "Start shared session");
        await first.waitForView(() => {
            expect(first.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain(
                "Start shared session",
            );
            expect(first.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
        });
        network.interruptNextTurn(delivery);
        await sendPrompt(first, await first.queryElementByTestId(dataTestId.messageComposer), "Report current model");
        await first.waitForView(() =>
            getByRole(document.body, "button", { name: "Retry message with unknown delivery" }),
        );
        const sessionId = new URL(window.location.href).searchParams.get("sessionId");
        if (sessionId === null || first.daemon === null) {
            throw new Error("Expected the shared Session");
        }
        await first.daemon.selectModel(sessionId, "test-large");
        await showReconnectNotice(first, clock);
        network.reconnect();
        await first.user.click(
            await first.waitForView(() => getByRole(document.body, "button", { name: "Retry now" })),
        );
        await first.waitForView(() => {
            expect(first.optionalElementByTestId(dataTestId.sessionReconnectNotice)).toBeNull();
            expect(first.elementByTestId(dataTestId.agentConfiguration).textContent).toContain("Test Large");
        });
        if (delivery === "before-acceptance") {
            await first.user.click(getByRole(document.body, "button", { name: "Retry message with unknown delivery" }));
        }
        await first.waitForView(() =>
            expect(first.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain(
                `Current model: ${delivery === "before-acceptance" ? "test-large" : "test-small"}`,
            ),
        );
        expect(network.submissions).toHaveLength(delivery === "before-acceptance" ? 3 : 2);
        if (delivery === "before-acceptance") {
            expect(await first.readSubmission(network.submissions[2])).toEqual(
                await first.readSubmission(network.submissions[1]),
            );
        }
        expect((await first.readSubmission(network.submissions[1])).sessionConfigurations).toEqual([]);
        expect(
            first
                .elementsByTestId(dataTestId.agentResponse)
                .filter((element) => element.textContent?.includes("Current model:")),
        ).toHaveLength(1);
        expect(first.elementByTestId(dataTestId.agentConfiguration).textContent).toContain("Test Large");
    });
}
