import { fireEvent, getByRole, queryByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";

test("Given an Agent takes longer than the Stop deadline, When the deadline passes, Then Chat keeps showing the reply stopping while the Computer stops it, and accepts a new message once the turn stops", {
    timeout: 30_000,
}, async () => {
    const cancellation = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const clock = new TestClock("2026-10-29T08:00:00Z");
    onTestFinished(() => {
        release.resolve();
    });
    const app = await createTestApp({
        connectAgent: true,
        clock,
        agent: {
            harness: "tool-lifecycle-test",
            label: "Controlled Agent",
            beforeCancellationApplied: async () => {
                cancellation.resolve();
                await release.promise;
            },
        },
    });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "answer then hold");
    await app.waitForView(() => expect(document.body.textContent).toContain("Partial answer before stopping."));
    const stop = await app.waitForView(() => getByRole(document.body, "button", { name: "Stop agent output" }));
    act(() => fireEvent.click(stop));
    await cancellation.promise;
    await act(async () => clock.advanceBy(15_001));
    await app.waitForView(() => {
        expect(getByRole(document.body, "button", { name: "Stopping agent output" })).toHaveProperty("disabled", true);
        expect(queryByRole(document.body, "alert")).toBeNull();
    });
    release.resolve();
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.agentReplyStatus).map((element) => element.textContent)).toContain(
            "Turn stopped.",
        );
    });
    expect.soft(queryByRole(document.body, "alert")).toBeNull();
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "answer after verification");
    await app.waitForView(() => expect(document.body.textContent).toContain("Verification finished with one failure."));
    expect(queryByRole(document.body, "alert")).toBeNull();
});

test("Given another page follows a running reply, When I press Stop and the Agent has not finished stopping, Then that page, and after a reload too, shows the reply stopping without offering Stop, and the turn stopped once the Agent stops", {
    timeout: 30_000,
}, async () => {
    const cancellation = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    onTestFinished(() => {
        release.resolve();
    });
    const app = await createTestApp({
        connectAgent: true,
        clock: new TestClock("2026-11-17T08:00:00Z"),
        agent: {
            harness: "tool-lifecycle-test",
            label: "Controlled Agent",
            beforeCancellationApplied: async () => {
                cancellation.resolve();
                await release.promise;
            },
        },
    });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "answer then hold");
    await app.waitForView(() => expect(document.body.textContent).toContain("Partial answer before stopping."));
    const viewer = await app.openViewer();
    onTestFinished(() => viewer.close());
    const composerAction = (page: TestApp): HTMLElement => page.elementByTestId(dataTestId.sendMessage);
    await viewer.waitForView(() => {
        expect(composerAction(viewer).getAttribute("aria-label")).toBe("Stop agent output");
        expect(composerAction(viewer)).toHaveProperty("disabled", false);
    });

    await app.user.click(app.elementByTestId(dataTestId.sendMessage));
    await cancellation.promise;

    await viewer.waitForView(() => {
        expect(composerAction(viewer).getAttribute("aria-label")).toBe("Stopping agent output");
        expect(composerAction(viewer)).toHaveProperty("disabled", true);
    });
    const reloaded = await viewer.reload();
    await reloaded.waitForView(() => {
        expect(reloaded.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain(
            "Partial answer before stopping.",
        );
        expect(composerAction(reloaded).getAttribute("aria-label")).toBe("Stopping agent output");
        expect(composerAction(reloaded)).toHaveProperty("disabled", true);
    });
    release.resolve();
    await reloaded.waitForView(() => {
        expect(reloaded.elementsByTestId(dataTestId.agentReplyStatus).map((element) => element.textContent)).toContain(
            "Turn stopped.",
        );
        expect(composerAction(reloaded).getAttribute("aria-label")).toBe("Send message");
    });
});

test("Given a follow-up the Computer rejected while a reply runs, When I ask to stop that reply, Then retrying the follow-up waits like the composer does", {
    timeout: 30_000,
}, async () => {
    const cancellation = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    onTestFinished(() => {
        release.resolve();
    });
    const app = await createTestApp({
        connectAgent: true,
        agent: {
            harness: "tool-lifecycle-test",
            label: "Controlled Agent",
            beforeCancellationApplied: async () => {
                cancellation.resolve();
                await release.promise;
            },
        },
    });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "answer then hold");
    await app.waitForView(() => expect(document.body.textContent).toContain("Partial answer before stopping."));
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "x".repeat(100_001));
    const retry = (): HTMLElement =>
        getByRole(app.elementByTestId(dataTestId.queuedMessage), "button", { name: "Retry message" });
    await app.waitForView(() => expect(retry()).toHaveProperty("disabled", false));

    const stop = await app.waitForView(() => getByRole(document.body, "button", { name: "Stop agent output" }));
    act(() => fireEvent.click(stop));
    await cancellation.promise;

    await app.waitForView(() => expect(retry()).toHaveProperty("disabled", true));
    expect(getByRole(document.body, "button", { name: "Stopping agent output" })).toHaveProperty("disabled", true);
});
