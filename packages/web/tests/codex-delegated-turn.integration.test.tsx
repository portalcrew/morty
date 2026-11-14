import { getByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { mortyReply } from "../../../tests/support/fake-daemon/scenarios.ts";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

const PROMPT = "Check the group history";

test("Given the Codex app owns the conversation, When it holds my message in its queue and then runs it, Then the pane says where the message waits and that only Codex can stop it, also after I reload the page", async () => {
    const app = await createTestApp({
        connectAgent: true,
        agent: {
            harness: "codex-app-owned",
            label: "Codex",
            reply: (prompt, turnNumber, mode) =>
                prompt === PROMPT
                    ? { outcome: "hold", output: [{ kind: "delegation", stage: "queued" }] }
                    : mortyReply(prompt, turnNumber, mode),
        },
    });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected the controlled Agent");
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), PROMPT);

    await app.waitForView(() => {
        expect(app.elementByTestId(dataTestId.workingIndicator).textContent).toBe(
            "Queued in Codex. If Codex paused its queue, choose Continue there.",
        );
        // A queued message can still be withdrawn from here.
        expect(getByRole(document.body, "button", { name: "Stop agent output" })).toHaveProperty("disabled", false);
    });

    await daemon.continueReply(PROMPT, {
        outcome: "hold",
        output: [{ kind: "delegation", stage: "started" }],
    });
    await app.waitForView(() => {
        expect(app.elementByTestId(dataTestId.workingIndicator).textContent).toMatch(
            /^Working for \d+s in CodexOnly Codex can stop it\.$/,
        );
        expect(getByRole(document.body, "button", { name: "Stop agent output" })).toHaveProperty("disabled", true);
    });

    // The Computer, not the page's memory of live events, says how far Codex has taken the message.
    const reloaded = await app.reload();
    await reloaded.waitForView(() => {
        expect(reloaded.elementByTestId(dataTestId.workingIndicator).textContent).toMatch(
            /^Working for \d+s in CodexOnly Codex can stop it\.$/,
        );
        expect(getByRole(document.body, "button", { name: "Stop agent output" })).toHaveProperty("disabled", true);
    });

    await daemon.continueReply(PROMPT, {
        outcome: "complete",
        output: [{ kind: "message", text: "Codex answered the queued message." }],
    });
    await reloaded.waitForView(() => {
        expect(document.body.textContent).toContain("Codex answered the queued message.");
        expect(reloaded.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
    });
    await reloaded.close();
});
