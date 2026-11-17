// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"fetch":{"disableSameOriginPolicy":true},"navigator":{"maxTouchPoints":5}}}
import { getByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { readyComposer, sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given a touch device, When I send a message, Then the composer releases focus so the software keyboard closes", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const composer = await readyComposer(app);

    await sendPrompt(app, composer, "Hello");
    await app.waitForView(() => expect(app.elementsByTestId(dataTestId.agentResponse).length).toBeGreaterThan(0));

    expect(app.elementByTestId(dataTestId.messageComposer)).not.toBe(document.activeElement);

    await sendPrompt(app, app.elementByTestId(dataTestId.messageComposer), "Again");
    await app.waitForView(() => expect(app.elementsByTestId(dataTestId.agentResponse).length).toBeGreaterThan(1));

    expect(app.elementByTestId(dataTestId.messageComposer)).not.toBe(document.activeElement);
});

test("Given an empty mobile composer, When I expand and tap its close control, Then it returns to the compact input", {
    timeout: 30_000,
}, async () => {
    const desktopViewport = { height: window.innerHeight, width: window.innerWidth };
    window.happyDOM.setViewport({ height: 844, width: 413 });
    try {
        const app = await createTestApp({ connectAgent: true });
        await readyComposer(app);

        await app.user.click(getByRole(document.body, "button", { name: "Expand message composer" }));
        expect(app.elementByTestId(dataTestId.messageComposer)).toBe(document.activeElement);

        await app.user.click(getByRole(document.body, "button", { name: "Collapse message composer" }));
        expect(app.elementByTestId(dataTestId.messageComposer)).not.toBe(document.activeElement);
        expect(getByRole(document.body, "button", { name: "Expand message composer" })).toBeDefined();
    } finally {
        window.happyDOM.setViewport(desktopViewport);
    }
});
