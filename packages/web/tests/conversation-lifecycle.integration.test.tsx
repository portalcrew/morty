import {
    fireEvent,
    getAllByRole,
    getByLabelText,
    getByRole,
    getByText,
    queryAllByRole,
    queryByRole,
    queryByTestId,
} from "@testing-library/dom";
import { flushSync } from "react-dom";
import { expect, onTestFinished, test, vi } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { openAgentModelPicker, readyComposer, sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";

test("Given a new conversation, When I send its first prompt, Then its preview and native message render without a history skeleton or panel remount", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    const conversationPanel = getByRole(document.body, "region", { name: "Conversation" });
    const loadingMessages: Element[] = [];
    let promptWasVisible = false;
    const observer = new MutationObserver((records) => {
        const promptVisible = app
            .elementsByTestId(dataTestId.userMessage)
            .some((element) => element.textContent === "hold after first delta");
        promptWasVisible ||= promptVisible;
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node instanceof Element) {
                    if (node.matches('[role="status"][aria-label="Loading messages"]')) {
                        loadingMessages.push(node);
                    }
                    loadingMessages.push(...node.querySelectorAll('[role="status"][aria-label="Loading messages"]'));
                }
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    onTestFinished(() => observer.disconnect());

    await sendPrompt(app, composer, "hold after first delta");

    await app.waitForView(() => {
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Partial reply")),
        ).toBe(true);
        expect(app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toEqual([
            "hold after first delta",
        ]);
    });
    expect(loadingMessages).toHaveLength(0);
    expect(promptWasVisible).toBe(true);
    expect(getByRole(document.body, "region", { name: "Conversation" })).toBe(conversationPanel);
    observer.disconnect();
    await app.user.click(
        await app.queryElementByTestId(
            dataTestId.sendMessage,
            (element) => element.getAttribute("aria-label") === "Stop agent output",
        ),
    );
});

test("Given a loaded session whose initial user chunk is delayed, When its first ACP event arrives and I steer, Then the submitted message stays visible until native chunks replace it without duplicates", async () => {
    const app = await createTestApp({
        connectAgent: true,
        agent: { harness: "tool-lifecycle-test", label: "Tool Lifecycle Agent" },
        page: { kind: "bootstrap", identity: true },
    });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "hold delayed initial message");
    await app.waitForView(() => {
        expect(getByRole(document.body, "button", { name: "Stop agent output" })).toBeDefined();
        expect(app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toEqual([
            "hold delayed initial message",
        ]);
        expect(app.optionalElementByTestId(dataTestId.sessionStatus)).not.toBeNull();
    });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "New steering requirement");
    const steer = await app.waitForView(() =>
        getByRole(document.body, "button", { name: "Steer queued message: New steering requirement" }),
    );
    await app.user.click(steer);
    const steeredProcess = await app.waitForView(() =>
        getByRole(document.body, "button", { name: "1 step", expanded: false }),
    );
    await app.user.click(steeredProcess);
    await app.waitForView(() => {
        expect(getByLabelText(document.body, "Tool: Steered verification")).toBeDefined();
        expect(app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toEqual([
            "hold delayed initial message",
            "New steering requirement",
        ]);
        expect(app.optionalElementByTestId(dataTestId.sessionStatus)).not.toBeNull();
    });
    await app.user.click(getByRole(document.body, "button", { name: "Stop agent output" }));
});

test("Given lifecycle events arrive before ACP output, When I queue a follow-up, Then the optimistic prompt remains until the first ACP event", async () => {
    const app = await createTestApp({
        connectAgent: true,
        agent: { harness: "tool-lifecycle-test", label: "Tool Lifecycle Agent" },
        page: { kind: "bootstrap", identity: true },
    });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "hold before first acp");
    await app.waitForView(() => getByRole(document.body, "button", { name: "Stop agent output" }));
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Release ACP output");
    const steer = await app.waitForView(() =>
        getByRole(document.body, "button", { name: "Steer queued message: Release ACP output" }),
    );
    expect(app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toEqual([
        "hold before first acp",
    ]);
    await app.user.click(steer);
    const steeredProcess = await app.waitForView(() =>
        getByRole(document.body, "button", { name: "1 step", expanded: false }),
    );
    await app.user.click(steeredProcess);
    await app.waitForView(() => {
        expect(getByLabelText(document.body, "Tool: Steered verification")).toBeDefined();
        expect(app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toEqual([
            "hold before first acp",
            "Release ACP output",
        ]);
    });
    await app.user.click(getByRole(document.body, "button", { name: "Stop agent output" }));
    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.agentReplyStatus).textContent).toBe("Turn stopped."),
    );
});

test("Given a configuration request is in flight, When the chat view detaches and re-attaches, Then the composer accepts and sends a new prompt", {
    timeout: 30_000,
}, async () => {
    const prompt = "Configuration cancelled by detach";
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, prompt);
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes(`Codex turn 1: ${prompt}`)),
        ).toBe(true),
    );
    // Start a configuration request and detach while it is in flight: the
    // request belongs to the conversation, not to the view, and must not lock
    // the re-attached view out of the composer.
    await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
    await openAgentModelPicker(app);
    const value = await app.queryElementByTestId(dataTestId.sessionConfigValue("test-large"));
    await app.user.click(value);
    app.remount();
    const restored = await app.waitForView(() => {
        const element = app.elementByTestId(dataTestId.messageComposer);
        if (!(element instanceof HTMLTextAreaElement)) {
            throw new Error("Expected the message composer after re-attach");
        }
        if (element.disabled) {
            throw new Error("The re-attached composer is still disabled by the cancelled configuration");
        }
        return element;
    });
    const followUp = "Usable again after the cancelled configuration";
    await sendPrompt(app, restored, followUp);
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes(`Codex turn 2: ${followUp}`)),
        ).toBe(true),
    );
});

test("Given an open conversation, When the chat view detaches and re-attaches, Then it shows the conversation's history", {
    timeout: 30_000,
}, async () => {
    const prompt = "Restore this conversation after re-attach";
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, prompt);
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes(`Codex turn 1: ${prompt}`)),
        ).toBe(true),
    );
    app.remount();
    // The re-attached view must show the conversation, not an empty or stale pane.
    await app.waitForView(() =>
        expect(app.elementsByTestId(dataTestId.userMessage).some((element) => element.textContent === prompt)).toBe(
            true,
        ),
    );
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes(`Codex turn 1: ${prompt}`)),
        ).toBe(true),
    );
});

test("Given a remounted conversation, When the user re-selects it from the directory, Then it reopens with its history and no failure", {
    timeout: 30_000,
}, async () => {
    const prompt = "Re-select during re-read";
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, prompt);
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes(`Codex turn 1: ${prompt}`)),
        ).toBe(true),
    );
    // Selecting the same conversation from the directory again replaces its
    // pane with a fresh home load. The replaced pane's cancellation must not
    // surface as a failure for the newer one.
    app.remount();
    const conversation = await app.queryElementByTestId(dataTestId.managedConversation);
    await app.user.click(conversation);
    await app.waitForView(() => {
        expect(queryByRole(document.body, "alert")).toBeNull();
        expect(app.elementsByTestId(dataTestId.userMessage).some((element) => element.textContent === prompt)).toBe(
            true,
        );
    });
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionLoadFailure)).toBeNull());
});

test("Given a saved-session entry is still loading, When the user selects New Session, Then a late failure cannot replace or disable the new draft", {
    timeout: 30_000,
}, async () => {
    let selectedDraft = false;
    const failures: string[] = [];
    const observer = new MutationObserver(() => {
        const connection = queryByTestId(document.body, dataTestId.botConnectionStatus);
        const newSession = queryByTestId(document.body, dataTestId.newConversation);
        if (
            !selectedDraft &&
            connection?.getAttribute("data-connection-status") === "connected" &&
            newSession !== null
        ) {
            // Select at the rendered boundary between configuration and session loading,
            // before the real server answers the missing-session request.
            selectedDraft = true;
            fireEvent.click(newSession);
        }
        const failure = queryByTestId(document.body, dataTestId.sessionLoadFailure);
        if (selectedDraft && failure !== null) {
            failures.push(failure.textContent ?? "");
        }
    });
    observer.observe(document.body, { attributes: true, childList: true, characterData: true, subtree: true });
    try {
        const app = await createTestApp({
            connectAgent: true,
            page: { kind: "managed-session", harness: "claude", sessionId: "chat_missing_session" },
        });
        const composer = await readyComposer(app);
        expect(selectedDraft).toBe(true);
        await sendPrompt(app, composer, "A fresh draft after leaving the pending session");
        await app.waitForView(() =>
            expect(
                app
                    .elementsByTestId(dataTestId.agentResponse)
                    .some((element) =>
                        element.textContent?.includes("Codex turn 1: A fresh draft after leaving the pending session"),
                    ),
            ).toBe(true),
        );
        expect(failures).toEqual([]);
    } finally {
        observer.disconnect();
    }
});

test("Given conversations updated across recent dates, When the directory loads, Then conversations are grouped by latest activity", {
    timeout: 60_000,
}, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
        vi.setSystemTime(new Date("2026-10-10T12:00:00+08:00"));
        const conversations = [
            { title: "Today conversation", updatedAt: "2026-10-10T12:00:00+08:00" },
            { title: "September conversation", updatedAt: "2026-09-02T12:00:00+08:00" },
            { title: "Previous 30 days conversation", updatedAt: "2026-10-02T12:00:00+08:00" },
            { title: "Previous 7 days conversation", updatedAt: "2026-10-06T12:00:00+08:00" },
            { title: "Yesterday conversation", updatedAt: "2026-10-09T12:00:00+08:00" },
        ] as const;
        const app = await createTestApp({
            connectAgent: true,
            agent: {
                harness: "codex",
                label: "Codex",
                reply: (prompt) => {
                    const conversation = conversations.find(({ title }) => title === prompt);
                    if (conversation === undefined) {
                        throw new Error("Expected a conversation with controlled activity metadata");
                    }
                    return {
                        outcome: "complete",
                        output: [
                            { kind: "session-updated-at", updatedAt: conversation.updatedAt },
                            { kind: "text", text: conversation.title },
                        ],
                    };
                },
            },
        });
        await app.queryElementByTestId(
            dataTestId.botConnectionStatus,
            (element) => element.getAttribute("data-connection-status") === "connected",
        );
        for (const [index, conversation] of conversations.entries()) {
            if (index > 0) {
                await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
            }
            const composer = await app.queryElementByTestId(dataTestId.messageComposer);
            if (!(composer instanceof HTMLTextAreaElement)) {
                throw new Error("Expected the message composer");
            }
            await sendPrompt(app, composer, conversation.title);
            await app.waitForView(() =>
                expect(
                    app
                        .elementsByTestId(dataTestId.agentResponse)
                        .some((element) => element.textContent?.includes(conversation.title) === true),
                ).toBe(true),
            );
            await app.waitForView(() => {
                const current = getByRole(document.body, "button", { current: "page" });
                expect(queryByTestId(current, dataTestId.sessionStatus)).toBeNull();
            });
        }

        await app.user.click(getByRole(document.body, "button", { name: "Refresh sessions" }));

        await app.waitForView(() => {
            expect(
                queryAllByRole(document.body, "heading", { level: 3 }).map((heading) => heading.textContent),
            ).toEqual(["Today", "Yesterday", "Previous 7 Days", "Previous 30 Days", "September 2026"]);
            expect(
                app
                    .elementsByTestId(dataTestId.managedConversation)
                    .map(
                        (conversation) =>
                            conversations.find(({ title }) => conversation.textContent?.includes(title) === true)
                                ?.title,
                    ),
            ).toEqual([
                "Today conversation",
                "Yesterday conversation",
                "Previous 7 days conversation",
                "Previous 30 days conversation",
                "September conversation",
            ]);
        });
    } finally {
        vi.useRealTimers();
    }
});

test("Given an unsent message draft, When the Chat application remounts, Then the draft remains in the composer", {
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
    await app.user.type(composer, "Keep this unsent draft");
    app.remount();
    const restored = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(restored instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the restored message composer");
    }
    await app.waitForView(() => expect(restored.value).toBe("Keep this unsent draft"));
});

test("Given a completed turn, When the user leaves and reopens it, Then daemon history restores one conversation", {
    timeout: 30_000,
}, async () => {
    const prompt = "Persist this completed conversation";
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, prompt);
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes(`Codex turn 1: ${prompt}`) === true),
        ).toBe(true),
    );
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    const conversation = await app.waitForView(() => {
        const candidate = app
            .elementsByTestId(dataTestId.managedConversation)
            .find((element) => element.textContent?.includes(prompt) === true);
        if (candidate === undefined) {
            throw new Error(`The completed conversation is unavailable: ${document.body.textContent}`);
        }
        return candidate;
    });
    await app.user.click(conversation);
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toEqual([prompt]);
        const replies = app
            .elementsByTestId(dataTestId.agentResponse)
            .filter((element) => element.textContent?.includes(`Codex turn 1: ${prompt}`) === true);
        expect(replies).toHaveLength(1);
        expect(replies[0]?.textContent).toContain(`Codex turn 1: ${prompt}`);
    });
    expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull();
});

test("Given the current saved Session, When the user closes it from its context menu, Then it leaves Recent sessions and the current session view is cleared", {
    timeout: 30_000,
}, async () => {
    const prompt = "Show the close Session action";
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, prompt);
    await app.waitForView(() =>
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain(prompt),
    );
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    const conversation = await app.queryElementByTestId(
        dataTestId.managedConversation,
        (element) => element.textContent?.includes(prompt) === true,
    );

    await app.user.pointer({ keys: "[MouseRight]", target: conversation });

    await app.waitForView(() => {
        expect(queryByRole(document.body, "menuitem", { name: "Close session" })).not.toBeNull();
        expect(queryByRole(document.body, "menuitem", { name: "Archive session" })).toBeNull();
    });
    await app.user.click(getByRole(document.body, "menuitem", { name: "Close session" }));
    await app.waitForView(() => expect(app.elementsByTestId(dataTestId.managedConversation)).toHaveLength(0));
    await app.waitForView(() => {
        expect(new URL(window.location.href).searchParams.has("sessionId")).toBe(false);
        expect(app.elementsByTestId(dataTestId.userMessage)).toHaveLength(0);
        expect(app.elementsByTestId(dataTestId.agentResponse)).toHaveLength(0);
        expect(app.optionalElementByTestId(dataTestId.sessionClosedNotice)).toBeNull();
    });
    expect(queryByRole(document.body, "alert")).toBeNull();
    const reloaded = await app.reload();
    await reloaded.queryElementByTestId(dataTestId.messageComposer);
    expect(new URL(window.location.href).searchParams.has("sessionId")).toBe(false);
    expect(reloaded.elementsByTestId(dataTestId.managedConversation)).toHaveLength(0);
    await sendPrompt(reloaded, await reloaded.queryElementByTestId(dataTestId.messageComposer), "Start after closing");
    await reloaded.waitForView(() =>
        expect(
            reloaded
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Start after closing")),
        ).toBe(true),
    );
});

test("Given another Session is selected, When the user closes a background Session, Then the current conversation and its draft stay open", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Background conversation");
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Background conversation")),
        ).toBe(true),
    );
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Current conversation");
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Current conversation")),
        ).toBe(true),
    );
    const currentSessionId = new URL(window.location.href).searchParams.get("sessionId");
    const composer = await readyComposer(app);
    await app.user.click(composer);
    await app.user.paste("Keep this draft");
    const background = await app.waitForView(() => {
        const entry = app
            .elementsByTestId(dataTestId.managedConversation)
            .find((element) => element.textContent?.includes("Background conversation"));
        if (entry === undefined) {
            throw new Error("Expected the background conversation");
        }
        return entry;
    });
    await app.user.pointer({ keys: "[MouseRight]", target: background });
    await app.user.click(await app.waitForView(() => getByRole(document.body, "menuitem", { name: "Close session" })));
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.managedConversation)).toHaveLength(1);
        expect(new URL(window.location.href).searchParams.get("sessionId")).toBe(currentSessionId);
        expect(app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toEqual([
            "Current conversation",
        ]);
        expect(app.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", "Keep this draft");
    });
});

test("Given a saved Session whose Computer becomes unavailable, When the user closes it, Then closing fails visibly, the entry stays and closing again after reconnecting removes it", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await sendPrompt(
        app,
        await app.queryElementByTestId(dataTestId.messageComposer),
        "Close with an unavailable Computer",
    );
    const conversation = await app.queryElementByTestId(dataTestId.managedConversation);
    flushSync(() => fireEvent.contextMenu(conversation));
    const close = await app.waitForView(() => getByRole(document.body, "menuitem", { name: "Close session" }));
    if (app.daemon === null) {
        throw new Error("Expected a connected Computer");
    }
    await app.daemon.disconnect();

    await app.user.click(close);

    await app.waitForView(() =>
        expect(getAllByRole(document.body, "alert").map((alert) => alert.textContent)).toContainEqual(
            expect.stringContaining("Your Morty Computer is disconnected."),
        ),
    );
    expect(app.elementsByTestId(dataTestId.managedConversation)).toHaveLength(1);
    expect(new URL(window.location.href).searchParams.has("sessionId")).toBe(true);

    await app.daemon.reconnect();
    flushSync(() => fireEvent.contextMenu(app.elementByTestId(dataTestId.managedConversation)));
    await app.user.click(await app.waitForView(() => getByRole(document.body, "menuitem", { name: "Close session" })));
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.managedConversation)).toHaveLength(0);
        expect(new URL(window.location.href).searchParams.has("sessionId")).toBe(false);
    });
});

test("Given a named conversation, When the user opens it, Then the Session title heads the conversation", {
    timeout: 30_000,
}, async () => {
    const title = "Show the Session title in the conversation header";
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, title);

    await app.waitForView(() =>
        expect(queryByRole(document.body, "heading", { level: 2, name: title })).not.toBeNull(),
    );
});

test("Given a new conversation titled from its prompt, When the Agent generates a title, Then the new title replaces it in the header and directory", {
    timeout: 30_000,
}, async () => {
    const promptTitle = "Use the Agent generated title";
    const agentTitle = "Agent generated title";
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, promptTitle);

    await app.waitForView(() => {
        expect(queryByRole(document.body, "heading", { level: 2, name: agentTitle })).not.toBeNull();
        expect(queryByRole(document.body, "heading", { level: 2, name: promptTitle })).toBeNull();
        expect(
            app
                .elementsByTestId(dataTestId.managedConversation)
                .some((conversation) => conversation.textContent?.includes(agentTitle) === true),
        ).toBe(true);
    });
});

test("Given an open conversation, When the user renames it from the header, Then the new title heads the conversation and its directory entry", {
    timeout: 30_000,
}, async () => {
    const prompt = "Rename this conversation from the header";
    const renamed = "Renamed from the header";
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, prompt);
    await app.waitForView(() =>
        expect(queryByRole(document.body, "heading", { level: 2, name: prompt })).not.toBeNull(),
    );
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes(`Codex turn 1: ${prompt}`) === true),
        ).toBe(true),
    );
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());

    await app.user.click(getByRole(document.body, "button", { name: prompt }));
    await app.waitForView(() =>
        expect(queryByRole(document.body, "textbox", { name: "Conversation title" })).not.toBeNull(),
    );
    const input = getByRole(document.body, "textbox", { name: "Conversation title" });
    await app.user.clear(input);
    await app.user.type(input, renamed);
    await app.user.click(getByRole(document.body, "button", { name: "Save title" }));

    await app.waitForView(() => {
        expect(queryByRole(document.body, "heading", { level: 2, name: renamed })).not.toBeNull();
        expect(queryByRole(document.body, "heading", { level: 2, name: prompt })).toBeNull();
        expect(
            app
                .elementsByTestId(dataTestId.managedConversation)
                .some((conversation) => conversation.textContent?.includes(renamed) === true),
        ).toBe(true);
    });
});

test("Given the header title editor is open, When the user cancels, Then the conversation keeps its title", {
    timeout: 30_000,
}, async () => {
    const prompt = "Keep this title when the rename is cancelled";
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, prompt);
    await app.waitForView(() =>
        expect(queryByRole(document.body, "heading", { level: 2, name: prompt })).not.toBeNull(),
    );

    await app.user.click(getByRole(document.body, "button", { name: prompt }));
    await app.waitForView(() =>
        expect(queryByRole(document.body, "textbox", { name: "Conversation title" })).not.toBeNull(),
    );
    const input = getByRole(document.body, "textbox", { name: "Conversation title" });
    await app.user.clear(input);
    await app.user.type(input, "Discarded title");
    await app.user.click(getByRole(document.body, "button", { name: "Cancel rename" }));

    await app.waitForView(() => {
        expect(queryByRole(document.body, "heading", { level: 2, name: prompt })).not.toBeNull();
        expect(queryByRole(document.body, "textbox", { name: "Conversation title" })).toBeNull();
    });
});

test("Given Claude Code does not echo the submitted prompt, When the response starts, Then my message is visible once", {
    timeout: 30_000,
}, async () => {
    const prompt = "Show this prompt without an Agent echo";
    const app = await createTestApp({
        connectAgent: true,
        agent: { harness: "claude-code", label: "Claude Code" },
    });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, prompt);

    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toEqual([prompt]);
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes(`Codex turn 1: ${prompt}`) === true),
        ).toBe(true);
    });
});

test("Given more saved messages than one history page, When live output arrives while the user loads more, Then older and live messages remain visible", {
    timeout: 90_000,
}, async () => {
    const prompts = Array.from({ length: 7 }, (_, index) => `many session events: Pagination message ${index + 1}`);
    // Pagination does not advance application time; CI speed must not trigger a heartbeat deadline.
    const clock = new TestClock("2026-11-07T00:00:00Z");
    const app = await createTestApp({ connectAgent: true, clock });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    for (const [index, prompt] of prompts.entries()) {
        const composer = await app.queryElementByTestId(dataTestId.messageComposer);
        if (!(composer instanceof HTMLTextAreaElement)) {
            throw new Error("Expected the message composer");
        }
        await sendPrompt(app, composer, prompt);
        await app.waitForView(() =>
            expect(
                app
                    .elementsByTestId(dataTestId.agentResponse)
                    .some(
                        (element) =>
                            element.textContent?.includes(`Completed Pagination message ${index + 1}`) === true,
                    ),
            ).toBe(true),
        );
        await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    }

    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    const conversation = await app.waitForView(() => {
        const candidate = app
            .elementsByTestId(dataTestId.managedConversation)
            .find((element) => element.textContent?.includes(prompts[0] ?? "") === true);
        if (candidate === undefined) {
            throw new Error(`The completed conversation is unavailable: ${document.body.textContent}`);
        }
        return candidate;
    });
    await app.user.click(conversation);
    await app.waitForView(() =>
        expect(app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toContain(
            prompts.at(-1),
        ),
    );
    const page = {
        prompts: app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent ?? ""),
        responses: app
            .elementsByTestId(dataTestId.agentResponse)
            .map((element) => element.textContent ?? "")
            .filter((text) => text.includes("Completed Pagination message")),
    };
    const expectSavedReasoning = async () => {
        for (const summary of queryAllByRole(document.body, "button", { name: "20 steps", expanded: false })) {
            await app.user.click(summary);
        }
        const reasoningItems = app.elementsByTestId(dataTestId.agentReasoning);
        expect(reasoningItems.length).toBeGreaterThan(0);
        for (const reasoning of reasoningItems) {
            if (reasoning instanceof HTMLDetailsElement && !reasoning.open) {
                await app.user.click(getByText(reasoning, "Show Thinking"));
            }
        }
        await app.waitForView(() => {
            expect(
                reasoningItems.some(
                    (reasoning) =>
                        reasoning.textContent?.includes("Reasoning step 000.") === true &&
                        reasoning.textContent.includes("Reasoning step 039."),
                ),
            ).toBe(true);
        });
    };
    expect(page.prompts).not.toContain(prompts[0]);
    expect(page.prompts.at(-1)).toBe(prompts.at(-1));
    expect(
        page.responses.some(
            (response) =>
                response.includes("Completed Pagination message 1") &&
                !response.includes(`Completed Pagination message ${prompts.length.toString()}`),
        ),
    ).toBe(false);
    expect(page.responses.at(-1)).toContain(`Completed Pagination message ${prompts.length.toString()}`);
    await expectSavedReasoning();
    await app.waitForView(() =>
        expect(getByRole(document.body, "textbox", { name: "Message" }).hasAttribute("disabled")).toBe(false),
    );
    const composer = getByRole(document.body, "textbox", { name: "Message" });
    if (!(composer instanceof HTMLTextAreaElement) || app.daemon === null) {
        throw new Error("Expected the message composer and controlled Agent");
    }
    const livePrompt = "hold after first delta";
    await sendPrompt(app, composer, livePrompt);
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Partial reply") === true),
        ).toBe(true),
    );
    const messages = queryByRole(document.body, "log", { name: "Messages" });
    if (!(messages instanceof HTMLElement)) {
        throw new Error("Expected the Session message list");
    }
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    onTestFinished(() => {
        vi.useRealTimers();
    });
    const loading = app.waitForView(() => getByRole(document.body, "status", { name: "Loading older messages" }));
    messages.scrollTop = 0;
    flushSync(() => fireEvent.scroll(messages));
    await loading;
    vi.useRealTimers();
    await app.daemon.continueReply(livePrompt, {
        outcome: "complete",
        output: [{ kind: "text", text: "Live completion while older messages load" }],
    });
    await app.waitForView(() => {
        const loadedPrompts = app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent);
        const loadedResponses = app
            .elementsByTestId(dataTestId.agentResponse)
            .map((element) => element.textContent ?? "");
        expect(loadedPrompts.length).toBeGreaterThan(page.prompts.length + 1);
        expect(loadedPrompts.slice(-(page.prompts.length + 1), -1)).toEqual(page.prompts);
        expect(loadedPrompts.at(-1)).toBe(livePrompt);
        expect(loadedResponses.some((response) => response.includes("Live completion while older messages load"))).toBe(
            true,
        );
    });
    const loadedPrompts = app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent ?? "");
    const loadedResponses = app.elementsByTestId(dataTestId.agentResponse).map((element) => element.textContent ?? "");
    const firstInitialPromptIndex = prompts.indexOf(page.prompts[0] ?? "");
    const newlyLoadedPrompt = prompts[firstInitialPromptIndex - 1];
    expect(newlyLoadedPrompt).toBeDefined();
    expect(loadedPrompts[0]).toBe(newlyLoadedPrompt);
    expect(loadedPrompts.at(-1)).toBe(livePrompt);
    expect(
        loadedResponses.some(
            (response) =>
                response.includes(`Completed Pagination message ${firstInitialPromptIndex.toString()}`) &&
                !response.includes(`Completed Pagination message ${prompts.length.toString()}`),
        ),
    ).toBe(true);
    expect(loadedResponses.some((response) => response.includes("Live completion while older messages load"))).toBe(
        true,
    );
    await expectSavedReasoning();
});

test("Given more saved messages than one history page, When older messages load, Then a skeleton placeholder stands in for them instead of a text label", {
    timeout: 90_000,
}, async () => {
    const prompts = Array.from({ length: 7 }, (_, index) => `many session events: Skeleton message ${index + 1}`);
    // Pagination does not advance application time; CI speed must not trigger a heartbeat deadline.
    const clock = new TestClock("2026-11-07T00:00:00Z");
    const app = await createTestApp({ connectAgent: true, clock });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    for (const [index, prompt] of prompts.entries()) {
        const composer = await app.queryElementByTestId(dataTestId.messageComposer);
        if (!(composer instanceof HTMLTextAreaElement)) {
            throw new Error("Expected the message composer");
        }
        await sendPrompt(app, composer, prompt);
        await app.waitForView(() =>
            expect(
                app
                    .elementsByTestId(dataTestId.agentResponse)
                    .some(
                        (element) => element.textContent?.includes(`Completed Skeleton message ${index + 1}`) === true,
                    ),
            ).toBe(true),
        );
        await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    }

    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    const conversation = await app.waitForView(() => {
        const candidate = app
            .elementsByTestId(dataTestId.managedConversation)
            .find((element) => element.textContent?.includes(prompts[0] ?? "") === true);
        if (candidate === undefined) {
            throw new Error(`The completed conversation is unavailable: ${document.body.textContent}`);
        }
        return candidate;
    });
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    onTestFinished(() => {
        vi.useRealTimers();
    });
    await app.user.click(conversation);
    await app.waitForView(() =>
        expect(getByRole(document.body, "textbox", { name: "Message" }).hasAttribute("disabled")).toBe(false),
    );
    const initialPrompts = await app.waitForView(() => {
        const loaded = app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent ?? "");
        expect(loaded).toContain(prompts.at(-1));
        expect(loaded).not.toContain(prompts[0]);
        return loaded;
    });
    const messages = queryByRole(document.body, "log", { name: "Messages" });
    if (!(messages instanceof HTMLElement)) {
        throw new Error("Expected the Session message list");
    }
    const loading = app.waitForView(() => getByRole(document.body, "status", { name: "Loading older messages" }));
    messages.scrollTop = 0;
    flushSync(() => fireEvent.scroll(messages));
    expect((await loading).textContent).not.toContain("Loading");

    await app.waitForView(() => {
        const loaded = app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent ?? "");
        expect(loaded.length).toBeGreaterThan(initialPrompts.length);
        expect(loaded.some((text) => !initialPrompts.includes(text))).toBe(true);
        expect(messages.textContent).toContain(prompts.at(-1));
        expect(queryByRole(document.body, "status", { name: "Loading older messages" })).toBeNull();
    });
});

test("Given a stale Session link, When the user opens it, Then the Session failure replaces the empty landing", {
    timeout: 30_000,
}, async () => {
    const sessionId = `chat_${"0".repeat(64)}`;
    const app = await createTestApp({
        connectAgent: true,
        page: { kind: "managed-session", harness: "claude", sessionId: sessionId },
    });

    const failure = await app.queryElementByTestId(dataTestId.sessionLoadFailure);
    expect(failure.getAttribute("role")).toBe("alert");
    expect(app.optionalElementByTestId(dataTestId.chatLanding)).toBeNull();
});

test("Given a completed turn, When I send another prompt, Then my prompt is visible once while the next reply is still streaming", {
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
    await sendPrompt(app, composer, "First completed turn");
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Codex turn 1: First completed turn") === true),
        ).toBe(true),
    );
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    const continuedComposer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(continuedComposer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected composer");
    }
    await sendPrompt(app, continuedComposer, "hold after first delta");
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Partial reply") === true),
        ).toBe(true),
    );
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toEqual([
            "First completed turn",
            "hold after first delta",
        ]);
        expect(app.optionalElementByTestId(dataTestId.sessionStatus)).not.toBeNull();
    });
    await app.user.click(
        await app.queryElementByTestId(
            dataTestId.sendMessage,
            (element) => element.getAttribute("aria-label") === "Stop agent output",
        ),
    );
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
});
