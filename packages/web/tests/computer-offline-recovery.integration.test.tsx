import { fireEvent, getByLabelText, getByRole, queryAllByRole, queryByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { readyComposer, refreshSessions, sendPrompt, showReconnectNotice } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";

// The Worker checks the Computer every 5 s and retries a failed check 5 s later, so one change can take two checks.
const COMPUTER_CHANGE_TIMEOUT_MS = 20_000;

function connectionStatus(app: TestApp): string | null {
    return app.elementByTestId(dataTestId.botConnectionStatus).getAttribute("data-connection-status");
}

function directoryTitles(app: TestApp): string[] {
    return app.elementsByTestId(dataTestId.managedConversation).map((entry) => entry.textContent ?? "");
}

function sidebarAlerts(): (string | null)[] {
    const sidebar = getByRole(document.body, "complementary", { name: "Morty navigation" });
    return queryAllByRole(sidebar, "alert").map((alert) => alert.textContent);
}

/** The accessible label of the status a directory entry shows, or null when it shows none. */
function entryStatus(app: TestApp, title: string): string | null {
    const entry = app
        .elementsByTestId(dataTestId.managedConversation)
        .find((candidate) => candidate.textContent?.includes(title));
    return entry?.querySelector(`[data-testid="${dataTestId.sessionStatus}"]`)?.getAttribute("aria-label") ?? null;
}

function agentAnswered(app: TestApp, text: string): boolean {
    return app.elementsByTestId(dataTestId.agentResponse).some((message) => message.textContent?.includes(text));
}

test("Given a saved conversation, When reloading it while its Computer is offline, Then its title and connection notice remain and reconnect restores history and the unsent draft", {
    timeout: 90_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    const draft = await readyComposer(app);
    await sendPrompt(app, draft, "Keep this conversation");
    await app.waitForView(() => expect(agentAnswered(app, "Codex turn 1: Keep this conversation")).toBe(true));

    const composer = await readyComposer(app);
    await app.user.click(composer);
    await app.user.paste("Keep this follow-up unsent");
    await app.user.click(getByRole(document.body, "button", { name: "Keep this conversation" }));
    const titleInput = getByRole(document.body, "textbox", { name: "Conversation title" });
    await app.user.clear(titleInput);
    await app.user.type(titleInput, "Saved offline conversation");
    await app.user.click(getByRole(document.body, "button", { name: "Save title" }));
    await app.waitForView(() =>
        expect(queryByRole(document.body, "heading", { name: "Saved offline conversation" })).not.toBeNull(),
    );

    await daemon.disconnect();
    const reopened = await app.reload();
    // A failed read must not present an existing conversation as a new, empty one.
    await reopened.waitForView(() => {
        expect(connectionStatus(reopened)).toBe("disconnected");
        expect(queryByRole(document.body, "button", { name: "Reconnect" })).not.toBeNull();
        expect(queryByRole(document.body, "heading", { name: "Saved offline conversation" })).not.toBeNull();
        expect(queryByRole(document.body, "heading", { name: "New session" })).toBeNull();
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
            "History is temporarily unavailable. It will load when the connection returns.",
        );
        expect(document.body.textContent).not.toContain("Your Morty Computer is disconnected.");
    }, COMPUTER_CHANGE_TIMEOUT_MS);

    // Connection and history recover independently. Every rendered recovery snapshot
    // must agree with the sidebar, including while the session read is still pending.
    const contradictoryNotices: string[] = [];
    const observer = new MutationObserver(() => {
        const messages = queryByRole(document.body, "log", { name: "Messages" })?.textContent ?? "";
        if (connectionStatus(reopened) === "connected" && messages.includes("Computer is offline")) {
            contradictoryNotices.push(messages);
        }
    });
    observer.observe(document.body, { childList: true, characterData: true, subtree: true, attributes: true });
    try {
        await daemon.reconnect();
        await reopened.waitForView(() => {
            expect(connectionStatus(reopened)).toBe("connected");
            expect(agentAnswered(reopened, "Codex turn 1: Keep this conversation")).toBe(true);
            const composer = reopened.elementByTestId(dataTestId.messageComposer);
            expect(composer instanceof HTMLTextAreaElement && !composer.disabled).toBe(true);
            expect(composer).toHaveProperty("value", "Keep this follow-up unsent");
            expect(
                reopened
                    .elementsByTestId(dataTestId.agentResponse)
                    .filter((message) => message.textContent?.includes("Codex turn 1: Keep this conversation")),
            ).toHaveLength(1);
            expect(getByRole(document.body, "log", { name: "Messages" }).textContent).not.toContain(
                "Keep this follow-up unsent",
            );
        }, COMPUTER_CHANGE_TIMEOUT_MS);
        expect(contradictoryNotices).toEqual([]);
    } finally {
        observer.disconnect();
    }
});

test("Given a saved conversation, When a new-session page opens while the Computer is offline and the Computer comes back, Then the sidebar lists the conversation without a refresh", {
    timeout: 90_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    await sendPrompt(app, await readyComposer(app), "Keep this conversation");
    await app.waitForView(() => expect(agentAnswered(app, "Codex turn 1: Keep this conversation")).toBe(true));
    await app.user.click(app.elementByTestId(dataTestId.newConversation));
    await app.waitForView(() => expect(directoryTitles(app)).toHaveLength(1));

    await daemon.disconnect();
    const reopened = await app.reload();
    // The sessions are read through the Computer, so the sidebar cannot list them while it is offline.
    await reopened.waitForView(() => {
        expect(connectionStatus(reopened)).toBe("disconnected");
        expect(sidebarAlerts()).toEqual([]);
        expect(document.body.textContent).toContain("Computer is offline. Sessions will appear when it reconnects.");
        expect(directoryTitles(reopened)).toHaveLength(0);
    }, COMPUTER_CHANGE_TIMEOUT_MS);

    await daemon.reconnect();
    await reopened.waitForView(() => {
        expect(connectionStatus(reopened)).toBe("connected");
        expect(directoryTitles(reopened).some((title) => title.includes("Keep this conversation"))).toBe(true);
        expect(sidebarAlerts()).toEqual([]);
    }, COMPUTER_CHANGE_TIMEOUT_MS);
});

test("Given a background reply is running when the Computer goes offline, When the Computer comes back, Then the sidebar shows that reply no longer working", {
    timeout: 90_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    await sendPrompt(app, await readyComposer(app), "Background conversation");
    await app.waitForView(() => {
        expect(agentAnswered(app, "Codex turn 1: Background conversation")).toBe(true);
        expect(entryStatus(app, "Background conversation")).toBeNull();
    });
    await app.user.click(app.elementByTestId(dataTestId.newConversation));
    await app.waitForView(() => expect(directoryTitles(app)).toHaveLength(1));
    // Another page starts a reply in the background conversation that is still running when the Computer goes away.
    const viewer = await app.openViewer();
    // A conversation opens only once its page is connected, and the draft page's composer is ready before that.
    await viewer.user.click(
        await viewer.queryElementByTestId(
            dataTestId.managedConversation,
            (entry) =>
                entry instanceof HTMLButtonElement &&
                !entry.disabled &&
                Boolean(entry.textContent?.includes("Background conversation")),
        ),
    );
    await viewer.waitForView(() => expect(agentAnswered(viewer, "Codex turn 1: Background conversation")).toBe(true));
    await sendPrompt(viewer, await readyComposer(viewer), "hold after first delta");
    await viewer.waitForView(() => {
        expect(agentAnswered(viewer, "Partial reply")).toBe(true);
        expect(entryStatus(viewer, "Background conversation")).toBe("Session working");
    });
    await refreshSessions(app);
    await app.waitForView(() => expect(entryStatus(app, "Background conversation")).toBe("Session working"));
    await viewer.close();

    await daemon.disconnect();
    await app.waitForView(() => expect(connectionStatus(app)).toBe("disconnected"), COMPUTER_CHANGE_TIMEOUT_MS);
    await daemon.reconnect();
    await app.waitForView(() => expect(connectionStatus(app)).toBe("connected"), COMPUTER_CHANGE_TIMEOUT_MS);

    await refreshSessions(app);
    await app.waitForView(
        () => expect(entryStatus(app, "Background conversation")).not.toBe("Session working"),
        COMPUTER_CHANGE_TIMEOUT_MS,
    );
});

for (const context of ["missing", "malformed", "different-session", "different-identity"] as const) {
    test(`Given ${context} remembered context, When an existing conversation reloads offline, Then it uses an honest fallback without leaking a different title`, {
        timeout: 45_000,
    }, async () => {
        const app = await createTestApp({ connectAgent: true });
        const daemon = app.daemon;
        if (daemon === null) {
            throw new Error("Expected a connected Computer");
        }
        await sendPrompt(app, await readyComposer(app), "Private saved conversation");
        await app.waitForView(() => expect(agentAnswered(app, "Codex turn 1: Private saved conversation")).toBe(true));
        // Browser persistence is an external input. Exercise invalid/absent data through a real page reload.
        const keys = Object.keys(window.sessionStorage).filter((key) => key.startsWith("morty:remembered-session:v1:"));
        for (const key of keys) {
            const saved = window.sessionStorage.getItem(key);
            window.sessionStorage.removeItem(key);
            if (context === "malformed") {
                window.sessionStorage.setItem(key, "{invalid json");
            } else if (context === "different-session") {
                window.sessionStorage.setItem(
                    key,
                    JSON.stringify({ id: "another-session", title: "Unrelated private title" }),
                );
            } else if (context === "different-identity" && saved !== null) {
                window.sessionStorage.setItem(`${key}-another-identity`, saved);
            }
        }
        await daemon.disconnect();
        const reopened = await app.reload();
        await reopened.waitForView(() => {
            expect(connectionStatus(reopened)).toBe("disconnected");
            expect(queryByRole(document.body, "heading", { name: "Existing session" })).not.toBeNull();
            expect(queryByRole(document.body, "heading", { name: "New session" })).toBeNull();
            expect(document.body.textContent).not.toContain("Private saved conversation");
            expect(document.body.textContent).not.toContain("Unrelated private title");
            expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
                "History is temporarily unavailable. It will load when the connection returns.",
            );
        }, COMPUTER_CHANGE_TIMEOUT_MS);
        await daemon.reconnect();
        await reopened.waitForView(
            () => expect(agentAnswered(reopened, "Codex turn 1: Private saved conversation")).toBe(true),
            COMPUTER_CHANGE_TIMEOUT_MS,
        );
    });
}

test("Given a remembered title for a session that no longer exists, When the server rejects its lookup, Then stale context is discarded and the failure is not described as offline", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await sendPrompt(app, await readyComposer(app), "A saved conversation");
    await app.waitForView(() => expect(agentAnswered(app, "Codex turn 1: A saved conversation")).toBe(true));
    const unavailableId = "chat_missing_session";
    for (const key of Object.keys(window.sessionStorage).filter((key) =>
        key.startsWith("morty:remembered-session:v1:"),
    )) {
        window.sessionStorage.setItem(key, JSON.stringify({ id: unavailableId, title: "Stale unavailable title" }));
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("conversationId");
    url.searchParams.set("sessionId", unavailableId);
    window.history.replaceState(null, "", url);
    const reopened = await app.reload();
    await reopened.waitForView(() => {
        expect(queryByRole(document.body, "button", { name: "Reconnect" })).not.toBeNull();
        expect(queryByRole(document.body, "heading", { name: "Existing session" })).not.toBeNull();
        expect(queryByRole(document.body, "heading", { name: "New session" })).toBeNull();
        expect(document.body.textContent).not.toContain("Stale unavailable title");
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).not.toContain("will load when");
    });
});

test("Given an open conversation, When its computer goes offline, Then the notice offers the restart command to copy", {
    timeout: 90_000,
}, async () => {
    const clock = new TestClock("2026-11-03T08:00:00Z");
    const app = await createTestApp({ connectAgent: true, clock });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    await sendPrompt(app, await readyComposer(app), "Check the build");
    await app.waitForView(() => expect(agentAnswered(app, "Codex turn 1: Check the build")).toBe(true));
    await daemon.disconnect();
    await showReconnectNotice(app, clock);
    const notice = await app.waitForView(() => {
        const element = app.elementByTestId(dataTestId.sessionReconnectNotice);
        expect(element.textContent).toContain("Computer is offline");
        return element;
    }, COMPUTER_CHANGE_TIMEOUT_MS);
    expect(getByRole(notice, "code").textContent).toBe("npx @morty-build/cli@latest start");
    await app.user.click(getByRole(notice, "button", { name: "Copy command" }));
    expect(await navigator.clipboard.readText()).toBe("npx @morty-build/cli@latest start");
});

test("Given the New Session page while the computer is offline, When an attachment is rejected, Then the connection status is detail inside that one alert", {
    timeout: 90_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    await daemon.disconnect();
    const reopened = await app.reload();
    await reopened.waitForView(
        () => expect(connectionStatus(reopened)).toBe("disconnected"),
        COMPUTER_CHANGE_TIMEOUT_MS,
    );
    const composer = await readyComposer(reopened);
    if (!(composer instanceof HTMLTextAreaElement) || composer.form === null) {
        throw new Error("Expected the New Session composer form");
    }
    const form = composer.form;
    // An empty file is rejected by the same reader the composer uses for real picks.
    fireEvent.change(getByLabelText(form, "Choose attachments"), {
        target: { files: [new File([new Uint8Array(0)], "empty.txt", { type: "text/plain" })] },
    });
    await act(async () => {});
    const alert = await reopened.waitForView(() => {
        const alerts = queryAllByRole(form, "alert");
        expect(alerts).toHaveLength(1);
        expect(alerts[0]?.textContent).toContain("Files must be between 1 byte");
        return alerts[0];
    });
    if (alert === undefined) {
        throw new Error("Expected the attachment failure alert");
    }
    // One headline, one assertive region: the offline status is its inline detail.
    expect(queryAllByRole(alert, "alert")).toHaveLength(0);
    expect(queryAllByRole(alert, "status")).toHaveLength(0);
    expect(alert.textContent).toContain("Make sure it’s awake and online.");
});
