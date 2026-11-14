import { getByRole, queryAllByRole, within } from "@testing-library/dom";
import { afterEach, expect, test, vi } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { refreshSessions, sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

afterEach(() => vi.useRealTimers());

async function loadAllResponseText(app: Awaited<ReturnType<typeof createTestApp>>, complete: () => boolean) {
    while (true) {
        const button = await app.waitForView(() => {
            if (complete()) {
                return null;
            }
            return getByRole(document.body, "button", { name: "Load more text" });
        });
        if (button === null) {
            return;
        }
        await app.user.click(button);
    }
}

test("Given an active turn exceeds one recovery page, When the user leaves and reopens the conversation, Then Chat restores every character and rich content", {
    timeout: 30_000,
}, async () => {
    const prompt = "hold after large output";
    const expectedCharacters = 300_000;
    const app = await createTestApp({ connectAgent: true });
    const responseCharacters = () =>
        app
            .elementsByTestId(dataTestId.agentResponse)
            .flatMap((element) => element.textContent?.match(/x{100,}/gu) ?? [])
            .reduce((total, text) => total + text.length, 0);
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, prompt);
    await app.queryElementByTestId(dataTestId.sessionStatus);
    await app.waitForView(() =>
        expect(queryAllByRole(document.body, "button", { name: "Load more text" })).not.toHaveLength(0),
    );
    await loadAllResponseText(app, () => responseCharacters() === expectedCharacters);
    await app.waitForView(() =>
        expect(responseCharacters(), document.body.textContent?.slice(0, 2000)).toBe(expectedCharacters),
    );
    await app.waitForView(() => expect(document.body.textContent).toContain("long-output.bin"));
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    const activeConversation = await app.waitForView(() => {
        const conversation = app
            .elementsByTestId(dataTestId.managedConversation)
            .find((candidate) => candidate.textContent?.includes(prompt) === true);
        if (conversation === undefined) {
            throw new Error(`The active conversation is unavailable: ${document.body.textContent}`);
        }
        return conversation;
    });
    await app.user.click(activeConversation);
    await app.queryElementByTestId(dataTestId.sessionStatus);
    while (responseCharacters() < expectedCharacters) {
        const button = await app.waitForView(() => {
            if (responseCharacters() === expectedCharacters) {
                return null;
            }
            const candidate = queryAllByRole(document.body, "button", { name: "Load more text" })[0];
            if (candidate === undefined) {
                throw new Error("Waiting for restored response text");
            }
            return candidate;
        });
        if (button !== null) {
            await app.user.click(button);
        }
    }
    await app.waitForView(() =>
        expect(responseCharacters(), document.body.textContent?.slice(0, 2000)).toBe(expectedCharacters),
    );
    await app.waitForView(() => expect(document.body.textContent).toContain("long-output.bin"));
    const stop = await app.queryElementByTestId(
        dataTestId.sendMessage,
        (element) => element.getAttribute("aria-label") === "Stop agent output",
    );
    await app.user.click(stop);
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    expect(document.body.textContent).toContain(prompt);
});

test("Given a partially streamed reply, When Chat remounts and the daemon continues, Then its working indicator, restored prefix, and file survive until completion", {
    timeout: 30_000,
}, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T08:00:00Z"));
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected composer");
    }
    await sendPrompt(app, composer, "hold after first delta");
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Partial reply") === true),
        ).toBe(true),
    );
    await app.waitForView(() =>
        expect(getByRole(document.body, "status", { name: "Agent is working" }).textContent).toBe("Working for 0s"),
    );
    app.remount();
    await app.queryElementByTestId(dataTestId.sessionStatus);
    await app.waitForView(() => expect(document.body.textContent).toContain("partial.bin"));
    await app.waitForView(() =>
        expect(getByRole(document.body, "status", { name: "Agent is working" }).textContent).toBe("Working for 0s"),
    );
    await daemon.continueReply("hold after first delta", {
        outcome: "hold",
        output: [{ kind: "text", text: " and the next streamed chunk" }],
    });
    await app.waitForView(() => {
        const text = app
            .elementsByTestId(dataTestId.agentResponse)
            .map((element) => element.textContent)
            .join("");
        expect(text).toContain("Partial reply");
        expect(text).toContain("and the next streamed chunk");
        expect(document.body.textContent).toContain("partial.bin");
        expect(app.optionalElementByTestId(dataTestId.sessionStatus)).not.toBeNull();
        expect(getByRole(document.body, "status", { name: "Agent is working" }).textContent).toBe("Working for 0s");
    });
    await daemon.continueReply("hold after first delta", {
        outcome: "complete",
        output: [{ kind: "text", text: " and the final chunk" }],
    });
    const text = await app.waitForView(() => {
        expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull();
        expect(queryAllByRole(document.body, "status", { name: "Agent is working" })).toHaveLength(0);
        const response = app
            .elementsByTestId(dataTestId.agentResponse)
            .map((element) => element.textContent)
            .join("");
        expect(response).toContain("and the final chunk");
        return response;
    });
    expect(text.match(/Partial reply/gu)).toHaveLength(1);
    expect(text.match(/and the next streamed chunk/gu)).toHaveLength(1);
    expect(text.match(/and the final chunk/gu)).toHaveLength(1);
    expect(document.body.textContent).toContain("partial.bin");
});

test("Given a conversation is running in the background, When it completes after starting a new conversation, Then its spinner becomes an unread badge", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected composer");
    }
    await sendPrompt(app, composer, "hold after first delta");
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Partial reply") === true),
        ).toBe(true),
    );
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    await app.queryElementByTestId(dataTestId.sessionStatus);
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    await daemon.continueReply("hold after first delta", { outcome: "complete", output: [] });
    await refreshSessions(app);
    await app.queryElementByTestId(
        dataTestId.sessionStatus,
        (element) => element.getAttribute("aria-label") === "Unread response",
    );
    const completedConversation = app
        .elementsByTestId(dataTestId.managedConversation)
        .find((element) => element.textContent?.includes("hold after first delta") === true);
    if (completedConversation === undefined) {
        throw new Error("Expected the completed conversation");
    }
    await app.user.click(completedConversation);
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.sessionStatus)
                .some((element) => element.getAttribute("aria-label") === "Unread response"),
        ).toBe(false),
    );
});

test("Given a running session, When the sidebar shows its status, Then the working icon is 14px", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, "hold after first delta");
    await app.waitForView(() => {
        const status = app.optionalElementByTestId(dataTestId.sessionStatus);
        if (status === null) {
            throw new Error("Expected the session status");
        }
        const icon = status.querySelector("svg");
        if (!(icon instanceof SVGElement)) {
            throw new Error("Expected the session status icon");
        }
        expect(icon.classList.contains("size-3.5")).toBe(true);
    });
});

test("Given a running reply, When the user reads the conversation, Then its working indicator appears in message history until completion", {
    timeout: 30_000,
}, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T08:00:00Z"));
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, "hold after first delta");
    await app.waitForView(() => {
        const messages = getByRole(document.body, "log", { name: "Messages" });
        expect(messages.textContent).toContain("Partial reply");
        const indicator = within(messages).getByRole("status", { name: "Agent is working" });
        const userMessage = app
            .elementsByTestId(dataTestId.userMessage)
            .find((message) => message.textContent?.includes("hold after first delta"));
        if (userMessage === undefined) {
            throw new Error("Expected the submitted user message");
        }
        expect(userMessage.compareDocumentPosition(indicator) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
        // The bubble reserves the 32px strip its copy button hangs through, and the
        // indicator keeps 4px of air below that strip, so they can never overlap.
        expect(userMessage.classList.contains("mb-8")).toBe(true);
        expect(indicator.parentElement?.classList.contains("mt-1")).toBe(true);
        expect(indicator.textContent).toBe("Working for 0s");
        expect(app.elementsByTestId(dataTestId.workingIndicator)).toHaveLength(1);
    });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    await daemon.continueReply("hold after first delta", {
        outcome: "complete",
        output: [{ kind: "text", text: " and the final chunk" }],
    });
    await app.waitForView(() => {
        const messages = getByRole(document.body, "log", { name: "Messages" });
        expect(messages.textContent).toContain("and the final chunk");
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
        expect(getByRole(document.body, "button", { name: "Send message" })).toBeDefined();
    });
    await sendPrompt(app, composer, "hold after first delta");
    await app.waitForView(() => {
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).not.toBeNull();
        expect(getByRole(document.body, "button", { name: "Stop agent output" })).toBeDefined();
    });
    await app.user.click(getByRole(document.body, "button", { name: "Stop agent output" }));
    await app.waitForView(() => {
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
        expect(getByRole(document.body, "button", { name: "Send message" })).toBeDefined();
    });
});

test("Given a message waited in the queue, When its turn starts, Then the working timer counts from the Computer's start, not from when it was queued", {
    timeout: 60_000,
}, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T08:00:00Z"));
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a real Computer");
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "wait for steering");
    await app.waitForView(() => expect(document.body.textContent).toContain("Waiting for steering"));
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "hold after first delta");
    await app.queryElementByTestId(
        dataTestId.queuedMessage,
        (element) => element.textContent?.includes("hold after first delta") === true,
    );
    // The follow-up waits in the queue for a few seconds before the first turn ends.
    vi.setSystemTime(new Date("2026-10-13T08:00:04Z"));
    await daemon.continueReply("wait for steering", { outcome: "complete", output: [] });
    await app.waitForView(() => {
        expect(app.optionalElementByTestId(dataTestId.queuedMessage)).toBeNull();
        expect(getByRole(document.body, "status", { name: "Agent is working" }).textContent).toMatch(
            /^Working for [0-2]s$/u,
        );
    });
    await daemon.continueReply("hold after first delta", { outcome: "complete", output: [] });
    await app.close();
});
