import { getByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { mortyReply } from "../../../tests/support/fake-daemon/scenarios.ts";
import { dataTestId } from "../src/data-testid.ts";
import { readyComposer, sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

const PROMPT = "Fix the failing build";
const SUGGESTION = "Run the tests again";

test("Given the Agent predicts my next prompt as its turn ends, When I return to the conversation and use the suggestion, Then it fills my message box and nothing is sent until I send it", async () => {
    const app = await createTestApp({
        connectAgent: true,
        agent: {
            harness: "claude",
            label: "Claude Code",
            reply: (prompt, turnNumber, mode) =>
                prompt === PROMPT
                    ? {
                          outcome: "complete",
                          output: [
                              { kind: "message", text: "The build passes now." },
                              { kind: "prompt-suggestion", text: SUGGESTION },
                          ],
                      }
                    : mortyReply(prompt, turnNumber, mode),
        },
    });
    await sendPrompt(app, await readyComposer(app), PROMPT);
    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.messageComposer).getAttribute("placeholder")).toBe(SUGGESTION),
    );

    const reloaded = await app.reload();
    const use = await reloaded.waitForView(() => getByRole(document.body, "button", { name: "Use suggested prompt" }));
    const composer = await readyComposer(reloaded);
    expect(composer.placeholder).toBe(SUGGESTION);
    await reloaded.user.click(use);

    await reloaded.waitForView(() => expect(composer.value).toBe(SUGGESTION));
    expect(reloaded.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toEqual([PROMPT]);
    await reloaded.close();
});
