import { getByLabelText, getByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { mortyReply } from "../../../tests/support/fake-daemon/scenarios.ts";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

const PROMPT = "Draft the page update";
const QUESTION = "Append the five sections to the existing page?";

test("Given the Agent asks me a question while it keeps working, When I pick a suggested answer, leave and return, and send it, Then the answer becomes my next message and the answered question keeps no pick and takes no further answers", async () => {
    const app = await createTestApp({
        connectAgent: true,
        agent: {
            harness: "codex-asks",
            label: "Codex",
            reply: (prompt, turnNumber, mode) =>
                prompt === PROMPT
                    ? {
                          outcome: "hold",
                          output: [
                              {
                                  kind: "message",
                                  text: `${QUESTION}\n- Update the page\n- Not now`,
                                  questions: [{ question: QUESTION, options: ["Update the page", "Not now"] }],
                              },
                          ],
                      }
                    : mortyReply(prompt, turnNumber, mode),
        },
    });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected the controlled Agent");
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), PROMPT);

    const card = await app.waitForView(() => getByRole(document.body, "region", { name: "Agent question" }));
    getByRole(card, "group", { name: QUESTION });
    expect(getByRole(card, "button", { name: "Send answer" })).toHaveProperty("disabled", true);
    await app.user.click(getByRole(card, "radio", { name: "Update the page" }));
    await app.waitForView(() =>
        expect(getByRole(card, "radio", { name: "Update the page" })).toHaveProperty("checked", true),
    );

    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    await app.user.click(
        await app.waitForView(() => {
            const entry = app
                .elementsByTestId(dataTestId.managedConversation)
                .find((element) => element.textContent?.includes(PROMPT) === true);
            if (entry === undefined) {
                throw new Error("Expected the conversation in the sidebar");
            }
            return entry;
        }),
    );
    const returned = await app.waitForView(() => getByRole(document.body, "region", { name: "Agent question" }));
    expect(getByRole(returned, "radio", { name: "Update the page" })).toHaveProperty("checked", true);
    const send = await app.waitForView(() => {
        const button = getByRole(returned, "button", { name: "Send answer" });
        expect(button).toHaveProperty("disabled", false);
        return button;
    });
    await app.user.click(send);

    // The Agent is still working, so the answer waits behind its turn like any message sent now.
    await app.waitForView(() => getByLabelText(document.body, "Edit queued message: Update the page"));
    await daemon.continueReply(PROMPT, { outcome: "complete", output: [] });
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toEqual([
            PROMPT,
            "Update the page",
        ]);
        const answered = getByRole(document.body, "region", { name: "Agent question" });
        expect(getByRole(answered, "radio", { name: "Not now" })).toHaveProperty("disabled", true);
        expect(getByRole(answered, "button", { name: "Send answer" })).toHaveProperty("disabled", true);
    });
    const answered = getByRole(document.body, "region", { name: "Agent question" });
    expect(getByRole(answered, "radio", { name: "Update the page" })).toHaveProperty("checked", false);
    const reloaded = await app.reload();
    await reloaded.waitForView(() => {
        const card = getByRole(document.body, "region", { name: "Agent question" });
        expect(getByRole(card, "radio", { name: "Not now" })).toHaveProperty("disabled", true);
        expect(getByRole(card, "radio", { name: "Update the page" })).toHaveProperty("checked", false);
    });
    await reloaded.close();
});
