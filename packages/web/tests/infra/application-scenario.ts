import { getAllByRole, getByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { dataTestId } from "../../src/data-testid.ts";
import type { TestApp } from "./test-app.tsx";
import type { TestClock } from "./test-clock.ts";

/** Expands every collapsed process segment summary so its tool and reasoning rows can be inspected. */
export async function expandProcessSections(app: TestApp): Promise<void> {
    const summaries = await app.waitForView(() => {
        const buttons = getAllByRole(document.body, "button").filter((button) =>
            /^\d+ steps?/.test(button.textContent ?? ""),
        );
        if (buttons.length === 0) {
            throw new Error("Missing process segment summary");
        }
        return buttons.filter((button) => button.getAttribute("aria-expanded") === "false");
    });
    for (const summary of summaries) {
        await app.user.click(summary);
    }
}

/**
 * Keeps every process segment expanded while waiting for a row-level read, so
 * segments that stream in or remount after the previous expansion (for example
 * when merged history pages rekey a segment) cannot hide their rows.
 */
export async function withExpandedProcess<T>(app: TestApp, read: () => T): Promise<T> {
    const deadline = Date.now() + 30_000;
    for (;;) {
        await expandProcessSections(app);
        try {
            return await app.waitForView(read, 1_000);
        } catch (cause) {
            if (Date.now() >= deadline) {
                throw cause;
            }
        }
    }
}

export async function openAgentModelPicker(app: TestApp): Promise<void> {
    await app.user.click(
        await app.queryElementByTestId(
            dataTestId.agentSetting("model"),
            (element) => element instanceof HTMLButtonElement && !element.disabled,
        ),
    );
}

/** The message composer once it accepts input. */
export async function readyComposer(app: TestApp): Promise<HTMLTextAreaElement> {
    const composer = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    return composer;
}

export async function sendPrompt(app: TestApp, composer: HTMLElement, prompt: string): Promise<void> {
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer to be a textarea");
    }
    await app.user.click(await readyComposer(app));
    await app.user.paste(prompt);
    const send = await app.waitForView(() => {
        const element = app.elementByTestId(dataTestId.sendMessage);
        if (
            !(element instanceof HTMLButtonElement) ||
            element.disabled ||
            element.getAttribute("aria-label") !== "Send message"
        ) {
            throw new Error(
                `Send is unavailable: draft=${composer.value}, disabled=${composer.disabled}, connected=${composer.isConnected}, button=${element.getAttribute("aria-label")}`,
            );
        }
        return element;
    });
    await app.user.click(send);
}

export async function openExecutionDetails(app: TestApp): Promise<HTMLElement> {
    await app.user.click(getByRole(document.body, "button", { name: /Switch computer/ }));
    await app.user.click(
        await app.waitForView(() => getByRole(document.body, "menuitem", { name: /View execution details/ })),
    );
    return app.waitForView(() => getByRole(document.body, "dialog", { name: "Execution details" }));
}

/** Advances the clock past the bridge retry delay and waits for Chat's bridge to reconnect. */
export async function recoverChat(app: TestApp, clock: TestClock, delayMs = 1_000): Promise<void> {
    await act(async () => {
        app.transport.open();
        clock.advanceBy(Math.max(5000, delayMs));
    });
}

/** Observe recovery through the UI before advancing its uninterrupted grace period. */
export async function showReconnectNotice(app: TestApp, clock: TestClock): Promise<void> {
    await app.waitForView(() =>
        getByRole(document.body, "button", { name: /Switch computer/, description: "Reconnecting" }),
    );
    await act(async () => clock.advanceBy(30_000));
    await app.waitForView(() => getByRole(document.body, "button", { name: "Retry now" }));
}

/** Refresh the list in this particular viewer. */
export async function refreshSessions(app: TestApp): Promise<void> {
    const root = app.elementByTestId(dataTestId.messageComposer).closest<HTMLElement>("[data-test-app-root]");
    if (!root) {
        throw new Error("Missing chat page");
    }
    const button = await app.waitForView(() => getByRole(root, "button", { name: "Refresh sessions" }));
    await app.user.click(button);
}
