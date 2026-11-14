import { queryAllByRole } from "@testing-library/dom";
import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { readyComposer, refreshSessions, sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";
import { createChatWorkerEnvironment, dedicatedEnvironmentTimeout } from "./support/chat-worker.ts";

function directoryEntry(app: TestApp, title: string): HTMLElement | undefined {
    return app.elementsByTestId(dataTestId.managedConversation).find((entry) => entry.textContent?.includes(title));
}

/** The accessible label of the status a directory entry shows, or null when it shows none. */
function entryStatus(app: TestApp, title: string): string | null {
    const entry = directoryEntry(app, title);
    return entry?.querySelector(`[data-testid="${dataTestId.sessionStatus}"]`)?.getAttribute("aria-label") ?? null;
}

test("Given a conversation whose turn failed, When the directory reloads with the Session idle, Then the sidebar still marks it failed", {
    timeout: 30_000,
}, async () => {
    const failedPrompt = "fail this turn explicitly";
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );

    await sendPrompt(app, await readyComposer(app), failedPrompt);
    await app.waitForView(() => expect(entryStatus(app, failedPrompt)).toBe("Session failed"));

    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    // Starting another conversation reloads the directory, whose snapshot reports the failed Session as idle.
    await sendPrompt(app, await readyComposer(app), "Start another conversation");
    await app.waitForView(() => {
        expect(directoryEntry(app, "Start another conversation")).toBeDefined();
        expect(entryStatus(app, failedPrompt)).toBe("Session failed");
    });
});

test("Given an open conversation, When I send a message the Computer has not received yet, Then the sidebar marks it working with the pane and clears the mark when the reply completes", {
    timeout: dedicatedEnvironmentTimeout,
}, async () => {
    const firstPrompt = "Start a conversation to follow up";
    const environment = await createChatWorkerEnvironment(false, true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true });
    const { executionNetwork } = app;
    if (executionNetwork === null) {
        throw new Error("Expected the execution transport proxy");
    }
    await sendPrompt(app, await readyComposer(app), firstPrompt);
    await app.waitForView(() => {
        expect(document.body.textContent).toContain(`Codex turn 1: ${firstPrompt}`);
        expect(directoryEntry(app, firstPrompt)).toBeDefined();
        expect(entryStatus(app, firstPrompt)).toBeNull();
    });

    const submission = executionNetwork.holdNextSubmission();
    await sendPrompt(app, await readyComposer(app), "Follow up while the Computer waits");
    const release = await submission;
    // The Computer has not received the message, so only the open pane knows the conversation works.
    await app.waitForView(() => expect(entryStatus(app, firstPrompt)).toBe("Session working"));

    release();
    await app.waitForView(() => {
        expect(document.body.textContent).toContain("Codex turn 2: Follow up while the Computer waits");
        expect(entryStatus(app, firstPrompt)).toBeNull();
    });
    await app.close();
});

test("Given a conversation still answering in the background, When I start another conversation and refresh after the first one finishes, Then the sidebar marks the first one unread", {
    timeout: dedicatedEnvironmentTimeout,
}, async () => {
    const heldPrompt = "hold after first delta";
    const environment = await createChatWorkerEnvironment(false, true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true });
    onTestFinished(() => app.close());
    const { daemon, executionNetwork } = app;
    if (daemon === null || executionNetwork === null) {
        throw new Error("Expected the connected Computer and its transport proxy");
    }
    await sendPrompt(app, await readyComposer(app), heldPrompt);
    await app.waitForView(() => expect(document.body.textContent).toContain("Partial reply"));
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    await app.waitForView(() => expect(entryStatus(app, heldPrompt)).toBe("Session working"));

    await sendPrompt(app, await readyComposer(app), "Start another conversation");
    await app.waitForView(() => expect(directoryEntry(app, "Start another conversation")).toBeDefined());
    await daemon.continueReply(heldPrompt, { outcome: "complete", output: [] });

    await refreshSessions(app);
    await app.waitForView(() => expect(entryStatus(app, heldPrompt)).toBe("Unread response"));
});

test("Given an earlier turn failed and a later one completed, When I return to the conversation, Then the earlier turn still shows its failure", {
    timeout: 30_000,
}, async () => {
    const failedPrompt = "fail this turn explicitly";
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    await sendPrompt(app, await readyComposer(app), failedPrompt);
    await app.waitForView(() =>
        expect(document.body.textContent).toContain("The controlled Agent rejected this turn."),
    );
    await sendPrompt(app, await readyComposer(app), "Follow up after the failure");
    await app.waitForView(() =>
        expect(document.body.textContent).toContain("Codex turn 2: Follow up after the failure"),
    );

    // Leaving and returning reloads the conversation from its history.
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    await app.waitForView(() => expect(document.body.textContent).not.toContain("Codex turn 2"));
    const entry = directoryEntry(app, failedPrompt);
    if (entry === undefined) {
        throw new Error("Expected the conversation in the directory");
    }
    await app.user.click(entry);
    await app.waitForView(() => {
        expect(document.body.textContent).toContain("Codex turn 2: Follow up after the failure");
        expect(document.body.textContent).toContain("The controlled Agent rejected this turn.");
    });
    await app.close();
});

test("Given a conversation I left while it was answering, When I return, watch the reply finish and leave again, Then the sidebar shows it neither working nor unread", {
    timeout: 30_000,
}, async () => {
    const heldPrompt = "hold after first delta";
    const app = await createTestApp({ connectAgent: true });
    onTestFinished(() => app.close());
    const { daemon } = app;
    if (daemon === null) {
        throw new Error("Expected the connected Computer");
    }
    await sendPrompt(app, await readyComposer(app), heldPrompt);
    await app.waitForView(() => expect(document.body.textContent).toContain("Partial reply"));
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    await app.waitForView(() => expect(entryStatus(app, heldPrompt)).toBe("Session working"));

    const entry = directoryEntry(app, heldPrompt);
    if (entry === undefined) {
        throw new Error("Expected the answering conversation in the directory");
    }
    await app.user.click(entry);
    await app.waitForView(() => expect(document.body.textContent).toContain("Partial reply"));
    await daemon.continueReply(heldPrompt, { outcome: "complete", output: [] });
    await app.waitForView(() => expect(entryStatus(app, heldPrompt)).toBeNull());

    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    await app.waitForView(() => expect(document.body.textContent).not.toContain("Partial reply"));
    expect(entryStatus(app, heldPrompt)).toBeNull();
    await refreshSessions(app);
    await app.waitForView(() =>
        expect(queryAllByRole(document.body, "button", { name: "Refreshing sessions" })).toHaveLength(0),
    );
    expect(entryStatus(app, heldPrompt)).toBeNull();
});
