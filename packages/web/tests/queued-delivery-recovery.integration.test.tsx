import { getByLabelText, getByRole, queryByRole } from "@testing-library/dom";
import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt, showReconnectNotice } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";
import { createChatWorkerEnvironment, dedicatedEnvironmentTimeout } from "./support/chat-worker.ts";

for (const interruption of ["before-acceptance", "after-acceptance"] as const) {
    test(`Given a queued message disconnects ${interruption}, When I reconnect and recover delivery, Then the instruction executes once and my next draft survives`, {
        timeout: dedicatedEnvironmentTimeout,
    }, async () => {
        const environment = await createChatWorkerEnvironment(true);
        onTestFinished(() => environment.close());
        const clock = new TestClock("2026-10-30T08:00:00Z");
        const app = await createTestApp({ environment, connectAgent: true, clock });
        const { network, daemon } = app;
        if (network === null || daemon === null) {
            throw new Error("Expected the controllable network and real Computer");
        }
        await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "wait for steering");
        await app.waitForView(() => expect(document.body.textContent).toContain("Waiting for steering"));
        await app.user.upload(
            getByLabelText(document.body, "Choose attachments"),
            new File(["Keep this queued attachment"], "pending.json", { type: "text/plain" }),
        );
        await app.waitForView(() =>
            expect(getByRole(document.body, "list", { name: "Attachments" }).textContent).toContain("pending.json"),
        );
        network.interruptNextTurn(interruption);
        await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Run this instruction once");
        await app.waitForView(() =>
            getByRole(document.body, "button", { name: "Retry message with unknown delivery" }),
        );
        const original = await app.readSubmission(network.submissions.at(-1));
        const submissions = network.submissions.length;
        await app.user.click(app.elementByTestId(dataTestId.messageComposer));
        await app.user.paste("Next draft survives recovery");
        await showReconnectNotice(app, clock);
        network.reconnect();
        await app.user.click(await app.waitForView(() => getByRole(document.body, "button", { name: "Retry now" })));
        await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionReconnectNotice)).toBeNull());
        if (interruption === "before-acceptance") {
            const retry = await app.waitForView(() => {
                const button = getByRole(document.body, "button", { name: "Retry message with unknown delivery" });
                expect(button.hasAttribute("disabled")).toBe(false);
                return button;
            });
            await app.user.click(retry);
        }
        await app.waitForView(() => {
            expect(queryByRole(document.body, "button", { name: "Retry message with unknown delivery" })).toBeNull();
            expect(app.elementsByTestId(dataTestId.queuedMessage).map((element) => element.textContent)).toEqual([
                "Run this instruction once",
            ]);
        });
        expect(network.submissions).toHaveLength(submissions + (interruption === "before-acceptance" ? 1 : 0));
        expect(await app.readSubmission(network.submissions.at(-1))).toEqual(original);
        expect(app.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", "Next draft survives recovery");
        await app.user.clear(app.elementByTestId(dataTestId.messageComposer));
        await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Queue drain marker");
        await app.waitForView(() =>
            expect(
                app
                    .elementsByTestId(dataTestId.queuedMessage)
                    .some((element) => element.textContent?.includes("Queue drain marker")),
            ).toBe(true),
        );
        await daemon.continueReply("wait for steering", { outcome: "complete", output: [] });
        await app.waitForView(() =>
            expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Queue drain marker"),
        );
        expect(
            app
                .elementsByTestId(dataTestId.userMessage)
                .filter((element) => element.textContent?.includes("Run this instruction once")),
        ).toHaveLength(1);
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .map((element) => element.textContent)
                .filter((content) => content?.includes("Run this instruction once")),
        ).toHaveLength(1);
    });
}
