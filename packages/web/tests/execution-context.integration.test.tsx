import { getByRole, queryByRole } from "@testing-library/dom";
import type { DetachedWindowAPI } from "happy-dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { openExecutionDetails, readyComposer, sendPrompt, showReconnectNotice } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";

declare global {
    interface Window {
        readonly happyDOM: DetachedWindowAPI;
    }
}

async function selectCodexHarness(app: TestApp): Promise<void> {
    await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
    const configuration = getByRole(document.body, "dialog", { name: "Agent configuration" });
    await app.user.click(getByRole(configuration, "radio", { name: "Codex" }));
    await app.user.keyboard("{Escape}");
    expect(queryByRole(document.body, "dialog", { name: "Agent configuration" })).toBeNull();
}

async function readDirectory(app: TestApp): Promise<string> {
    const dialog = await openExecutionDetails(app);
    const directory = app.elementByTestId(dataTestId.executionDirectory, dialog).textContent ?? "";
    expect(directory.length).toBeGreaterThan(0);
    await app.user.keyboard("{Escape}");
    expect(queryByRole(document.body, "dialog", { name: "Execution details" })).toBeNull();
    return directory;
}

test("Given a connected computer, When the user views a conversation, Then its header stays compact and connection details are available on demand", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await readyComposer(app);
    const computer = getByRole(document.body, "button", { name: /Switch computer/ });
    // The computer heads the sidebar with its status in words, not only as a colored dot.
    expect(computer.getAttribute("aria-label")).toMatch(/, Online$/u);
    expect(queryByRole(document.body, "status", { name: "Connection" })).toBeNull();
    const details = await openExecutionDetails(app);
    expect(details.textContent).toContain("Computer status");
    expect(details.textContent).toContain("Online");
    expect(details.textContent).toContain("Session connection");
    expect(details.textContent).toContain("Not started");
});

test("Given a connected computer on mobile, When the user views the conversation, Then computer information stays in navigation instead of the header", {
    timeout: 30_000,
}, async () => {
    const desktopViewport = { height: window.innerHeight, width: window.innerWidth };
    window.happyDOM.setViewport({ height: 844, width: 413 });
    let app: TestApp | null = null;
    try {
        app = await createTestApp({ connectAgent: true });
        await readyComposer(app);
        const newSession = getByRole(document.body, "button", { name: "New Session" });
        const header = newSession.closest("header");
        expect(header).not.toBeNull();
        if (header === null) {
            throw new Error("Expected the mobile New Session action in the header");
        }
        expect(queryByRole(header, "button", { name: /Switch computer/ })).toBeNull();

        await app.user.click(getByRole(header, "button", { name: "Open navigation" }));
        const computers = await app.waitForView(() => getByRole(document.body, "navigation", { name: "Computers" }));
        await app.waitForView(() => expect(computers.textContent).toContain("Controlled Agent Runtime"));
    } finally {
        if (app !== null) {
            await app.close();
        }
        window.happyDOM.setViewport(desktopViewport);
    }
});

test("Given a connected Computer, When a saved conversation disconnects and recovers, Then its shared connection indicator and details follow the session without losing its directory", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock("2026-10-21T08:00:00Z");
    const app = await createTestApp({ connectAgent: true, clock });
    await readyComposer(app);
    await selectCodexHarness(app);
    const directoryName = await readDirectory(app);
    await sendPrompt(app, app.elementByTestId(dataTestId.messageComposer), "Remember this execution context");
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Codex turn 1")),
        ).toBe(true),
    );
    await app.waitForView(() =>
        getByRole(document.body, "button", { name: /Switch computer/, description: "Connection available" }),
    );
    expect(queryByRole(document.body, "status", { name: "Connection" })).toBeNull();
    expect(await readDirectory(app)).toBe(directoryName);
    const details = await openExecutionDetails(app);
    expect(details.textContent).toContain("Connected");
    expect(details.textContent).toContain("Online");
    await app.user.keyboard("{Escape}");
    if (app.daemon === null) {
        throw new Error("Expected a connected Computer");
    }
    await app.daemon.disconnect();
    await showReconnectNotice(app, clock);
    await app.queryElementByTestId(
        dataTestId.sessionReconnectNotice,
        (element) => element.textContent?.includes("Retry now") === true,
    );
    expect(
        queryByRole(document.body, "button", { name: /Switch computer/, description: "Connection available" }),
    ).toBeNull();
    const interrupted = await openExecutionDetails(app);
    expect(interrupted.textContent).toContain("Reconnecting");
    expect(app.elementByTestId(dataTestId.executionDirectory, interrupted).textContent).toBe(directoryName);
    await app.user.keyboard("{Escape}");
    await app.daemon.reconnect();
    await app.user.click(getByRole(document.body, "button", { name: "Retry now" }));
    await app.waitForView(() =>
        getByRole(document.body, "button", { name: /Switch computer/, description: "Connection available" }),
    );
    expect(app.optionalElementByTestId(dataTestId.sessionReconnectNotice)).toBeNull();
});

test("Given a saved conversation and a different draft directory, When the user switches conversations, Then the context follows the selected conversation rather than the draft default", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await readyComposer(app);
    await selectCodexHarness(app);
    const originalDirectory = await readDirectory(app);
    expect(getByRole(document.body, "button", { name: /Switch computer/ }).textContent).toContain(
        "Controlled Agent Runtime",
    );
    await sendPrompt(
        app,
        await app.queryElementByTestId(dataTestId.messageComposer),
        "Original directory conversation",
    );
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Original directory conversation")),
        ).toBe(true),
    );
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    await app.user.click(app.elementByTestId(dataTestId.newConversation));
    await app.user.click(await app.queryElementByTestId(dataTestId.workingDirectory));
    await app.user.click(app.elementByTestId(dataTestId.changeWorkingDirectory));
    await app.user.click(await app.waitForView(() => getByRole(document.body, "button", { name: ".." })));
    await app.user.click(
        await app.queryElementByTestId(
            dataTestId.saveWorkingDirectory,
            (element) => element instanceof HTMLButtonElement && !element.disabled,
        ),
    );
    await app.waitForView(() =>
        expect(queryByRole(document.body, "dialog", { name: "Choose working directory" })).toBeNull(),
    );
    const changedDirectory = await readDirectory(app);
    expect(changedDirectory).not.toBe(originalDirectory);
    await sendPrompt(app, app.elementByTestId(dataTestId.messageComposer), "Changed directory conversation");
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Changed directory conversation")),
        ).toBe(true),
    );
    for (const { title, expectedDirectory } of [
        { title: "Original directory conversation", expectedDirectory: originalDirectory },
        { title: "Changed directory conversation", expectedDirectory: changedDirectory },
    ]) {
        const saved = await app.waitForView(() => {
            const conversation = app
                .elementsByTestId(dataTestId.managedConversation)
                .find((element) => element.textContent?.includes(title));
            if (conversation === undefined) {
                throw new Error(
                    `Waiting for ${title}: ${app
                        .elementsByTestId(dataTestId.managedConversation)
                        .map((element) => element.textContent)
                        .join(" | ")}`,
                );
            }
            return conversation;
        });
        await app.user.click(saved);
        await app.waitForView(() =>
            getByRole(document.body, "button", { name: /Switch computer/, description: "Connection available" }),
        );
        expect(await readDirectory(app)).toBe(expectedDirectory);
    }
});

test("Given no paired Computer, When the user dismisses setup and inspects the computer, Then execution details distinguish pairing from a session that has not started", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp();
    await app.queryElementByTestId(dataTestId.pairingInstruction);
    await app.user.click(getByRole(document.body, "button", { name: "Close dialog" }));
    const details = await openExecutionDetails(app);
    expect(details.textContent).toContain("Unknown");
    expect(details.textContent).toContain("Not paired");
    expect(details.textContent).toContain("Not started");
});
