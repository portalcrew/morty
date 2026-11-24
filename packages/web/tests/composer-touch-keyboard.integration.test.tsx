// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"fetch":{"disableSameOriginPolicy":true},"navigator":{"maxTouchPoints":5}}}
import { getByRole, queryByRole } from "@testing-library/dom";
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

test("Given a touch device, When I press Return on its software keyboard and then Enter on a hardware keyboard, Then Return breaks the line and Enter sends while I keep typing", {
    timeout: 30_000,
}, async () => {
    const viewport = { height: window.innerHeight, width: window.innerWidth };
    try {
        const app = await createTestApp({ connectAgent: true });
        const composer = await readyComposer(app);

        await app.user.click(composer);
        await app.user.keyboard("First line");
        await app.waitForView(() =>
            expect(app.elementByTestId(dataTestId.sendMessage)).toHaveProperty("disabled", false),
        );
        window.happyDOM.setViewport({ height: viewport.height - 300 });
        await app.user.keyboard("{Enter}");
        expect(composer).toHaveProperty("value", "First line\n");

        window.happyDOM.setViewport(viewport);
        await app.user.keyboard("Second line{Enter}");
        await app.waitForView(() => expect(app.elementsByTestId(dataTestId.agentResponse)).toHaveLength(1));
        expect(document.body.textContent).toContain("Second line");
        expect(app.elementByTestId(dataTestId.messageComposer)).toBe(document.activeElement);
    } finally {
        window.happyDOM.setViewport(viewport);
    }
});

test("Given an empty mobile composer, When I expand it, Then it has no close control and tapping outside compacts it", {
    timeout: 30_000,
}, async () => {
    const desktopViewport = { height: window.innerHeight, width: window.innerWidth };
    window.happyDOM.setViewport({ height: 844, width: 413 });
    try {
        const app = await createTestApp({ connectAgent: true });
        await readyComposer(app);

        await app.user.click(getByRole(document.body, "button", { name: "Expand message composer" }));
        expect(app.elementByTestId(dataTestId.messageComposer)).toBe(document.activeElement);
        expect(queryByRole(document.body, "button", { name: "Collapse message composer" })).toBeNull();

        await app.user.click(getByRole(document.body, "button", { name: "Open navigation" }));
        await app.user.click(getByRole(document.body, "button", { name: "Close navigation", expanded: true }));
        expect(app.elementByTestId(dataTestId.messageComposer)).not.toBe(document.activeElement);
        expect(getByRole(document.body, "button", { name: "Expand message composer" })).toBeDefined();
    } finally {
        window.happyDOM.setViewport(desktopViewport);
    }
});

test("Given an expanded empty mobile composer, When I use its controls, Then it stays expanded", {
    timeout: 30_000,
}, async () => {
    const desktopViewport = { height: window.innerHeight, width: window.innerWidth };
    window.happyDOM.setViewport({ height: 844, width: 413 });
    try {
        const app = await createTestApp({ connectAgent: true });
        await readyComposer(app);

        await app.user.click(getByRole(document.body, "button", { name: "Expand message composer" }));
        await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
        const configuration = getByRole(document.body, "dialog", { name: "Agent configuration" });
        await app.user.click(getByRole(configuration, "button", { name: "Close Agent configuration" }));

        expect(queryByRole(document.body, "button", { name: "Expand message composer" })).toBeNull();
        await app.user.click(getByRole(document.body, "button", { name: "Add attachment" }));
        expect(queryByRole(document.body, "button", { name: "Expand message composer" })).toBeNull();
    } finally {
        window.happyDOM.setViewport(desktopViewport);
    }
});

test("Given a mobile reply is generating with an empty inactive composer, When I view its compact input, Then Stop remains available", {
    timeout: 30_000,
}, async () => {
    const desktopViewport = { height: window.innerHeight, width: window.innerWidth };
    window.happyDOM.setViewport({ height: 844, width: 413 });
    try {
        const app = await createTestApp({
            connectAgent: true,
            agent: { harness: "tool-lifecycle-test", label: "Controlled Agent" },
        });
        await sendPrompt(app, await readyComposer(app), "answer then hold");
        await app.waitForView(() => expect(document.body.textContent).toContain("Partial answer before stopping."));

        const composer = app.elementByTestId(dataTestId.messageComposer);
        expect(composer).toHaveProperty("value", "");
        expect(composer).not.toBe(document.activeElement);
        await app.waitForView(() => getByRole(document.body, "button", { name: "Expand message composer" }));

        const stop = getByRole(document.body, "button", { name: "Stop agent output" });
        expect(stop).toHaveProperty("disabled", false);
        await app.user.click(stop);
        await app.waitForView(() =>
            expect(app.elementsByTestId(dataTestId.agentReplyStatus).map((element) => element.textContent)).toContain(
                "Turn stopped.",
            ),
        );
    } finally {
        window.happyDOM.setViewport(desktopViewport);
    }
});
