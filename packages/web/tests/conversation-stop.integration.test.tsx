import { fireEvent, getByRole, queryByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";

test("Given an Agent takes longer than the Stop deadline, When its cancelled turn later settles, Then Chat clears the unconfirmed-stop notice and accepts a new message", {
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
    const notice = await app.waitForView(() => getByRole(document.body, "alert"));
    expect
        .soft(notice.textContent)
        .toBe("Stopping has not been confirmed. The agent may still be running. Try Stop again.");
    expect(getByRole(document.body, "button", { name: "Stop agent output" }).hasAttribute("disabled")).toBe(false);
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
