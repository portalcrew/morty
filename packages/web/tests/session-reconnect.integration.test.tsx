import {
    fireEvent,
    getByLabelText,
    getByRole,
    queryAllByRole,
    queryAllByTestId,
    queryAllByText,
    queryByRole,
} from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { readyComposer, sendPrompt, showReconnectNotice } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";
import { createChatWorkerEnvironment, dedicatedEnvironmentTimeout } from "./support/chat-worker.ts";

function reconnectStatusText(app: TestApp): string | null {
    const notice = app.optionalElementByTestId(dataTestId.sessionReconnectNotice);
    if (notice === null) {
        return null;
    }
    return notice.textContent;
}

function retrySeconds(app: TestApp): number {
    const match = /Retrying in (\d+) s/u.exec(reconnectStatusText(app) ?? "");
    if (match === null) {
        throw new Error("Waiting for the visible retry countdown");
    }
    return Number(match[1]);
}

/** How the composer notice slot is placed: floating over the log, or in flow above a queue/interaction stack. */
function noticePlacement(app: TestApp): string | null {
    const notice = app.optionalElementByTestId(dataTestId.sessionReconnectNotice);
    return notice?.closest("[data-notice-placement]")?.getAttribute("data-notice-placement") ?? null;
}

const CLOCK_ORIGIN = "2026-10-13T08:00:00Z";

test("Given native operation capacity is occupied, When I reopen a saved Session and capacity clears, Then its connection recovers automatically and I can keep chatting", {
    timeout: dedicatedEnvironmentTimeout,
}, async () => {
    const release = Promise.withResolvers<void>();
    onTestFinished(() => release.resolve());
    let holding = false;
    const clock = new TestClock(CLOCK_ORIGIN);
    const app = await createTestApp({
        connectAgent: true,
        clock,
        agent: {
            harness: "settings-test",
            label: "Settings Agent",
            beforeSessionsListed: async (signal) => {
                if (!holding) {
                    return;
                }
                signal.throwIfAborted();
                await new Promise<void>((resolve, reject) => {
                    const aborted = () => {
                        signal.removeEventListener("abort", aborted);
                        reject(signal.reason);
                    };
                    signal.addEventListener("abort", aborted, { once: true });
                    void release.promise.then(() => {
                        signal.removeEventListener("abort", aborted);
                        resolve();
                    });
                });
            },
        },
    });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Established session");
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Established session");
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
    });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected the real Computer");
    }
    holding = true;
    const signal = AbortSignal.timeout(30_000);
    // The first four real operations occupy admission; only the surplus request can settle before the ACP gate opens.
    const reads = Array.from({ length: 5 }, () =>
        daemon.readNativeSessions(signal).then(
            (value) => ({ kind: "listed" as const, value }),
            (cause: unknown) => ({ kind: "failed" as const, cause }),
        ),
    );
    const first = await Promise.race(reads);
    expect(first).toMatchObject({ kind: "failed", cause: { code: "native_session_busy" } });
    const sessionId = new URL(window.location.href).searchParams.get("sessionId");
    if (sessionId === null) {
        throw new Error("Expected an open Session");
    }
    await expect(daemon.readExecution(sessionId, signal)).rejects.toMatchObject({
        name: "MortyOperationError",
        code: "native_session_busy",
        outcome: "unknown",
    });
    const reloaded = await app.reload();
    await clock.waitForSleep(1000, AbortSignal.timeout(10_000));
    await reloaded.user.click(await reloaded.queryElementByTestId(dataTestId.messageComposer));
    await reloaded.user.paste("Continue after capacity clears");
    expect(getByRole(document.body, "button", { name: "Send message" })).toHaveProperty("disabled", true);
    release.resolve();
    await Promise.all(reads);
    // The first automatic retry has a five-second ceiling; advance application time past its whole countdown.
    await act(async () => clock.advanceBy(5000));
    await reloaded.waitForView(() => {
        expect(reloaded.optionalElementByTestId(dataTestId.sessionLoadFailure)).toBeNull();
        expect(getByRole(document.body, "button", { name: "Send message" })).toHaveProperty("disabled", false);
    });
    expect(reloaded.elementByTestId(dataTestId.messageComposer)).toHaveProperty(
        "value",
        "Continue after capacity clears",
    );
    await reloaded.user.click(getByRole(document.body, "button", { name: "Send message" }));
    await reloaded.waitForView(() =>
        expect(reloaded.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain(
            "Continue after capacity clears",
        ),
    );
});

test("Given a new session with an unsent draft, When the browser resumes after repeated background bridge drops, Then it reconnects without flashing a notice or sending the draft", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock(CLOCK_ORIGIN);
    const app = await createTestApp({ connectAgent: true, clock });
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    await app.user.type(composer, "Keep this new session draft");
    await app.waitForView(() =>
        expect(getByRole(document.body, "button", { name: "Send message" })).toHaveProperty("disabled", false),
    );
    for (const cycle of [1, 2]) {
        app.transport.disconnect();
        await app.waitForView(() =>
            expect(getByRole(document.body, "button", { name: "Send message" })).toHaveProperty("disabled", true),
        );
        expect(reconnectStatusText(app), `interruption ${cycle}`).toBeNull();
        expect(composer).toHaveProperty("disabled", false);
        const notices: string[] = [];
        const observer = new MutationObserver(() => {
            const notice = reconnectStatusText(app);
            if (notice !== null) {
                notices.push(notice);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        try {
            await act(async () => {
                window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
                app.transport.open();
                clock.advanceBy(30_000);
                window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
            });
            await app.waitForView(() =>
                expect(getByRole(document.body, "button", { name: "Send message" })).toHaveProperty("disabled", false),
            );
            expect(notices).toEqual([]);
        } finally {
            observer.disconnect();
        }
        await act(async () => clock.advanceBy(30_000));
        expect(reconnectStatusText(app)).toBeNull();
        expect(composer).toHaveProperty("value", "Keep this new session draft");
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).not.toContain(
            "Keep this new session draft",
        );
    }
});

test("Given a new session with an interrupted bridge, When recovery takes thirty seconds, Then one retry notice appears and clears without sending the draft", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock(CLOCK_ORIGIN);
    const app = await createTestApp({ connectAgent: true, clock });
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    await app.user.type(composer, "Keep editing through the interruption");
    await app.waitForView(() =>
        expect(getByRole(document.body, "button", { name: "Send message" })).toHaveProperty("disabled", false),
    );
    app.transport.disconnect();
    await app.waitForView(() =>
        expect(getByRole(document.body, "button", { name: "Send message" })).toHaveProperty("disabled", true),
    );
    expect(reconnectStatusText(app)).toBeNull();
    // Observe the deadline before advancing the suspended page's clock; network I/O resumes afterwards.
    const notice = app.waitForView(() => {
        expect(reconnectStatusText(app)).toContain("Connection interrupted");
        expect(getByRole(document.body, "button", { name: "Retry now" })).toBeDefined();
    });
    await act(async () => {
        app.transport.open();
        clock.advanceBy(30_000);
    });
    await notice;
    // Nothing sits between the log and this draft composer, so the notice floats over the log.
    expect(noticePlacement(app)).toBe("overlay");
    await app.waitForView(() =>
        expect(getByRole(document.body, "button", { name: "Send message" })).toHaveProperty("disabled", false),
    );
    expect(reconnectStatusText(app)).toBeNull();
    expect(composer).toHaveProperty("value", "Keep editing through the interruption");
    expect(getByRole(document.body, "log", { name: "Messages" }).textContent).not.toContain(
        "Keep editing through the interruption",
    );
});

test("Given an online computer and a saved session, When the session first loads, Then the composer stays writable without a connection notice until sending becomes available", {
    timeout: dedicatedEnvironmentTimeout,
}, async () => {
    const environment = await createChatWorkerEnvironment(false, true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true, clock: new TestClock(CLOCK_ORIGIN) });
    await openSavedConversation(app, "Quiet first loading");
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    if (app.executionNetwork === null) {
        throw new Error("Expected a real execution-read proxy");
    }
    const held = app.executionNetwork.holdNextExecution();
    await app.user.click(getByRole(document.body, "button", { name: "Open Quiet first loading" }));
    const release = await held;
    try {
        expect(reconnectStatusText(app)).toBeNull();
        expect(getByRole(document.body, "button", { name: "Send message" })).toHaveProperty("disabled", true);
        const composer = getByRole(document.body, "textbox", { name: "Message" });
        await app.user.type(composer, "Draft while loading");
        expect(composer).toHaveProperty("value", "Draft while loading");
    } finally {
        release();
    }
    await app.waitForView(() =>
        expect(getByRole(document.body, "button", { name: "Send message" })).toHaveProperty("disabled", false),
    );
    expect(reconnectStatusText(app)).toBeNull();
});

test("Given an open conversation with a draft, When recovery after two background suspensions takes twelve seconds, Then it stays quiet without sending the draft", {
    timeout: dedicatedEnvironmentTimeout,
}, async () => {
    const clock = new TestClock(CLOCK_ORIGIN);
    const environment = await createChatWorkerEnvironment(false, true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true, clock });
    const composer = await openSavedConversation(app, "Quiet recovery");
    if (app.daemon === null || app.executionNetwork === null) {
        throw new Error("Expected the connected Computer and real execution-read proxy");
    }
    await app.user.type(composer, "Keep writing through recovery");
    for (const cycle of [1, 2]) {
        await app.daemon.disconnect();
        await app.waitForView(() =>
            getByRole(document.body, "button", { name: /Switch computer/, description: "Reconnecting" }),
        );
        expect(getByRole(document.body, "button", { name: "Send message" })).toHaveProperty("disabled", true);
        expect(reconnectStatusText(app), `interruption ${cycle}`).toBeNull();
        expect(composer.disabled).toBe(false);
        await act(async () => {
            window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
            clock.advanceBy(30_000);
        });
        const held = app.executionNetwork.holdNextExecution();
        await app.daemon.reconnect();
        await act(async () => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
        const release = await held;
        try {
            await act(async () => clock.advanceBy(12_000));
            expect(reconnectStatusText(app), `slow foreground recovery ${cycle}`).toBeNull();
            expect(getByRole(document.body, "button", { name: "Send message" })).toHaveProperty("disabled", true);
        } finally {
            release();
        }
        await app.waitForView(() =>
            expect(getByRole(document.body, "button", { name: "Send message" })).toHaveProperty("disabled", false),
        );
        await act(async () => clock.advanceBy(30_000));
        expect(reconnectStatusText(app)).toBeNull();
        expect(composer.value).toBe("Keep writing through recovery");
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).not.toContain(composer.value);
    }
});

test("Given an interrupted conversation, When recovery lasts thirty seconds across attempts, Then one actionable notice appears and clears on recovery", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock(CLOCK_ORIGIN);
    const app = await createTestApp({ connectAgent: true, clock });
    const composer = await openSavedConversation(app, "Persistent interruption");
    if (app.daemon === null) {
        throw new Error("Expected the connected Computer");
    }
    await app.user.type(composer, "Still unsent");
    await app.daemon.disconnect();
    await app.waitForView(() =>
        getByRole(document.body, "button", { name: /Switch computer/, description: "Reconnecting" }),
    );
    expect(getByRole(document.body, "button", { name: "Send message" })).toHaveProperty("disabled", true);
    expect(reconnectStatusText(app)).toBeNull();
    await act(async () => clock.advanceBy(29_999));
    expect(reconnectStatusText(app)).toBeNull();
    await act(async () => clock.advanceBy(1));
    await app.waitForView(() => expect(reconnectStatusText(app)).not.toBeNull());
    expect(app.elementsByTestId(dataTestId.sessionReconnectNotice)).toHaveLength(1);
    const retry = await app.waitForView(() => getByRole(document.body, "button", { name: "Retry now" }));
    await app.daemon.reconnect();
    await app.user.click(retry);
    await app.waitForView(() =>
        getByRole(document.body, "button", { name: /Switch computer/, description: "Connection available" }),
    );
    expect(reconnectStatusText(app)).toBeNull();
    expect(composer.value).toBe("Still unsent");
});

test("Given an offline Computer, When the retry deadline elapses, Then the countdown advances and automatic retries back off", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock(CLOCK_ORIGIN);
    const app = await createTestApp({ connectAgent: true, clock });
    await openSavedConversation(app, "Survive a Computer restart");
    if (app.daemon === null) {
        throw new Error("Expected the connected Computer");
    }
    await app.daemon.disconnect();
    await showReconnectNotice(app, clock);
    const firstDelay = await app.waitForView(() => retrySeconds(app));
    expect(firstDelay).toBeGreaterThanOrEqual(5);
    expect(firstDelay).toBeLessThanOrEqual(10);
    const notice = app.elementByTestId(dataTestId.sessionReconnectNotice);
    const form = notice.closest("form");
    if (form === null) {
        throw new Error("Expected the composer form");
    }
    expect(queryByRole(form, "alert")).toBeNull();
    expect(noticePlacement(app)).toBe("overlay");
    await act(async () => clock.advanceBy(1000));
    expect(retrySeconds(app)).toBe(firstDelay - 1);
    await act(async () => clock.advanceBy((firstDelay - 2) * 1000));
    expect(retrySeconds(app)).toBe(1);
    await act(async () => clock.advanceBy(1000));
    const secondDelay = await app.waitForView(() => retrySeconds(app));
    expect(secondDelay).toBeGreaterThanOrEqual(10);
    expect(secondDelay).toBeLessThanOrEqual(20);
    expect(queryByRole(form, "alert")).toBeNull();
    await act(async () => clock.advanceBy(secondDelay * 1000));
    const thirdDelay = await app.waitForView(() => retrySeconds(app));
    expect(thirdDelay).toBeGreaterThanOrEqual(15);
    expect(thirdDelay).toBeLessThanOrEqual(30);
});

async function openSavedConversation(app: TestApp, prompt: string): Promise<HTMLTextAreaElement> {
    const draft = await readyComposer(app);
    if (!(draft instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the draft composer");
    }
    await sendPrompt(app, draft, prompt);
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((message) => message.textContent?.includes(`Codex turn 1: ${prompt}`)),
        ).toBe(true),
    );
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    const saved = await app.waitForView(() => {
        const conversation = app
            .elementsByTestId(dataTestId.managedConversation)
            .find((candidate) => candidate.textContent?.includes(prompt));
        if (conversation === undefined) {
            throw new Error("Waiting for the saved conversation");
        }
        return conversation;
    });
    await app.user.click(saved);
    await app.waitForView(() =>
        expect(queryByRole(document.body, "heading", { level: 2, name: prompt })).not.toBeNull(),
    );
    const composer = await readyComposer(app);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the saved conversation composer");
    }
    return composer;
}

test("Given a failed Agent turn, When its Computer reconnects and the conversation reloads, Then the failure is never duplicated and the reload still shows how the turn ended", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock(CLOCK_ORIGIN);
    const app = await createTestApp({ connectAgent: true, clock });
    const composer = await openSavedConversation(app, "Before the failed turn");
    if (app.daemon === null) {
        throw new Error("Expected a connected Computer");
    }
    const form = composer.closest("form");
    if (form === null) {
        throw new Error("Expected the composer form");
    }
    await sendPrompt(app, composer, "fail this turn explicitly");
    const messages = getByRole(document.body, "log", { name: "Messages" });
    await app.waitForView(() => {
        expect(queryByRole(messages, "alert")?.textContent, document.body.textContent ?? "").toContain(
            "The controlled Agent rejected this turn.",
        );
        expect(queryByRole(form, "alert")).toBeNull();
    });
    await app.daemon.disconnect();
    await showReconnectNotice(app, clock);
    expect(
        queryAllByText(document.body, "Internal error: The controlled Agent rejected this turn.", { exact: true }),
    ).toHaveLength(1);
    await app.daemon.reconnect();
    const retry = queryByRole(form, "button", { name: "Retry now" });
    if (!(retry instanceof HTMLButtonElement)) {
        throw new Error("Expected manual reconnect control");
    }
    await app.user.click(retry);
    await app.waitForView(() => {
        getByRole(document.body, "button", { name: /Switch computer/, description: "Connection available" });
        expect(composer.disabled).toBe(false);
        expect(reconnectStatusText(app)).toBeNull();
    });
    // The restarted Computer's history restates how the turn ended from its execution receipt: once, with the summary
    // the receipt keeps across a restart in place of the Agent's own error text.
    await app.waitForView(() => {
        expect(
            queryAllByText(document.body, "The local Agent could not complete the request", { exact: true }),
        ).toHaveLength(1);
        expect(
            queryAllByText(document.body, "Internal error: The controlled Agent rejected this turn.", { exact: true }),
        ).toHaveLength(0);
        expect(queryAllByRole(document.body, "alert")).toHaveLength(1);
    });
    const reloaded = await app.reload();
    await reloaded.queryElementByTestId(dataTestId.messageComposer);
    // A reload restates the same ending, once.
    await reloaded.waitForView(() => {
        expect(
            queryAllByText(document.body, "Internal error: The controlled Agent rejected this turn.", { exact: true }),
        ).toHaveLength(0);
        expect(
            queryAllByText(document.body, "The local Agent could not complete the request", { exact: true }),
        ).toHaveLength(1);
    });
});

test("Given a recovered Computer and an unsent draft, When the retry deadline arrives, Then Chat recovers automatically without sending the draft", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock(CLOCK_ORIGIN);
    const app = await createTestApp({ connectAgent: true, clock });
    const composer = await openSavedConversation(app, "Recover automatically");
    if (app.daemon === null) {
        throw new Error("Expected the connected Computer");
    }
    await app.user.click(composer);
    await app.user.paste("Still unsent");
    await app.daemon.disconnect();
    await app.waitForView(() =>
        getByRole(document.body, "button", { name: /Switch computer/, description: "Reconnecting" }),
    );
    await app.daemon.reconnect();
    expect(composer.disabled).toBe(false);
    expect(getByRole(document.body, "button", { name: "Send message" })).toHaveProperty("disabled", true);
    expect(reconnectStatusText(app)).toBeNull();
    await act(async () => clock.advanceBy(5_000));
    await app.waitForView(() => {
        expect(reconnectStatusText(app)).toBeNull();
        expect(composer.disabled).toBe(false);
        expect(getByRole(document.body, "button", { name: "Send message" })).toHaveProperty("disabled", false);
    });
    expect(queryByRole(composer.closest("form") ?? document.body, "alert")).toBeNull();
    expect(composer.value).toBe("Still unsent");
    expect(getByRole(document.body, "log", { name: "Messages" }).textContent).not.toContain("Still unsent");
    await act(async () => clock.advanceBy(60000));
    expect(composer.disabled).toBe(false);
    expect(getByRole(document.body, "log", { name: "Messages" }).textContent).not.toContain("Still unsent");
});

test("Given an unavailable Computer and an editable draft, When automatic retries are exhausted and the user retries, Then one actionable failure clears and the draft is never sent automatically", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock(CLOCK_ORIGIN);
    const app = await createTestApp({ connectAgent: true, clock });
    const composer = await openSavedConversation(app, "Recover after exhausted retries");
    if (app.daemon === null) {
        throw new Error("Expected a connected Computer");
    }
    await app.user.type(composer, "Keep editing through failure");
    await app.daemon.disconnect();
    await showReconnectNotice(app, clock);
    for (let attempt = 0; attempt < 6; attempt += 1) {
        const seconds = await app.waitForView(() => retrySeconds(app));
        await act(async () => clock.advanceBy(seconds * 1000));
    }
    await app.waitForView(() => expect(getByRole(document.body, "alert").textContent).toContain("Couldn’t reconnect"));
    // The headline must own the alert's title slot alone: a nested alert here would
    // stack a second headline inside the first and reopen the gap this notice fixed.
    const noticeAlert = getByRole(document.body, "alert");
    expect(queryAllByTestId(noticeAlert, dataTestId.sessionReconnectNotice)).toHaveLength(0);
    const retryLink = getByRole(noticeAlert, "button", { name: "Retry now" });
    expect(retryLink).not.toBeNull();
    // An attachment failure takes over the headline too, so the connection state has
    // to fold into that single alert instead of nesting a second assertive region.
    const liveComposer = await readyComposer(app);
    if (!(liveComposer instanceof HTMLTextAreaElement) || liveComposer.form === null) {
        throw new Error("Expected the live composer form");
    }
    const composerForm = liveComposer.form;
    fireEvent.change(getByLabelText(composerForm, "Choose attachments"), {
        target: { files: [new File([new Uint8Array(0)], "empty.txt", { type: "text/plain" })] },
    });
    await act(async () => {});
    const attachmentAlert = await app.waitForView(() => {
        const alerts = queryAllByRole(composerForm, "alert");
        expect(alerts).toHaveLength(1);
        expect(alerts[0]?.textContent).toContain("Files must be between 1 byte");
        return alerts[0];
    });
    // Exactly one assertive region: the attachment headline owns it, and the
    // connection state is its detail rather than a nested alert.
    expect(composerForm.querySelectorAll('[role="alert"]')).toHaveLength(1);
    if (attachmentAlert === undefined) {
        throw new Error("Expected the attachment failure alert");
    }
    expect(attachmentAlert.textContent).toContain("Automatic retries stopped");
    expect(queryAllByRole(attachmentAlert, "status")).toHaveLength(0);
    expect(getByRole(attachmentAlert, "button", { name: "Retry now" })).not.toBeNull();
    expect(composer.disabled).toBe(false);
    expect(getByRole(document.body, "button", { name: "Send message" })).toHaveProperty("disabled", true);
    await app.user.type(composer, " even now");
    fireEvent.change(getByLabelText(composerForm, "Choose attachments"), {
        target: {
            files: [new File(["Keep this unsent attachment"], "recovery-notes.json", { type: "text/plain" })],
        },
    });
    await app.waitForView(() =>
        expect(getByRole(document.body, "list", { name: "Attachments" }).textContent).toContain("recovery-notes.json"),
    );
    expect(
        queryByRole(document.body, "button", { name: /Switch computer/, description: "Connection available" }),
    ).toBeNull();
    // Retrying by hand restores the automatic retries, which reconnect once the computer is back.
    await app.user.click(getByRole(document.body, "button", { name: "Retry now" }));
    await showReconnectNotice(app, clock);
    const seconds = await app.waitForView(() => {
        const match = /Retrying in (\d+) s/u.exec(document.body.textContent ?? "");
        if (match === null) {
            throw new Error("Waiting for the restored retry countdown");
        }
        return Number(match[1]);
    });
    await app.daemon.reconnect();
    await act(async () => clock.advanceBy(seconds * 1000));
    await app.waitForView(() =>
        getByRole(document.body, "button", { name: /Switch computer/, description: "Connection available" }),
    );
    expect(reconnectStatusText(app)).toBeNull();
    expect(queryByRole(document.body, "alert")).toBeNull();
    expect(composer.value).toBe("Keep editing through failure even now");
    expect(getByRole(document.body, "list", { name: "Attachments" }).textContent).toContain("recovery-notes.json");
    expect(getByRole(document.body, "button", { name: "Send message" })).toHaveProperty("disabled", false);
    expect(getByRole(document.body, "log", { name: "Messages" }).textContent).not.toContain(
        "Keep editing through failure",
    );
});

test("Given an open conversation whose automatic retries are exhausted, When the page sees its computer online again, Then the conversation reconnects without the user retrying", {
    timeout: 60_000,
}, async () => {
    const clock = new TestClock(CLOCK_ORIGIN);
    const app = await createTestApp({ connectAgent: true, clock });
    await openSavedConversation(app, "Reconnect when the computer returns");
    if (app.daemon === null) {
        throw new Error("Expected a connected Computer");
    }
    await app.daemon.disconnect();
    await showReconnectNotice(app, clock);
    for (let attempt = 0; attempt < 6; attempt += 1) {
        const seconds = await app.waitForView(() => retrySeconds(app));
        await act(async () => clock.advanceBy(seconds * 1000));
    }
    await app.waitForView(() => expect(getByRole(document.body, "alert").textContent).toContain("Couldn’t reconnect"));
    await app.waitForView(
        () =>
            expect(app.elementByTestId(dataTestId.botConnectionStatus).getAttribute("data-connection-status")).toBe(
                "disconnected",
            ),
        20_000,
    );
    await app.daemon.reconnect();
    await app.waitForView(() =>
        getByRole(document.body, "button", {
            name: /^Switch computer, .*, Online$/u,
            description: "Connection available",
        }),
    );
    expect(reconnectStatusText(app)).toBeNull();
    expect(queryByRole(document.body, "alert")).toBeNull();
});

test("Given an active turn and an unsent follow-up, When connection freshness is lost and Enter is pressed, Then the follow-up stays in the composer until recovery", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock(CLOCK_ORIGIN);
    const app = await createTestApp({ connectAgent: true, clock });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "wait for steering");
    await app.queryElementByTestId(dataTestId.sessionStatus);
    await app.waitForView(() =>
        getByRole(document.body, "button", { name: /Switch computer/, description: "Connection available" }),
    );
    expect(reconnectStatusText(app)).toBeNull();
    const composer = await readyComposer(app);
    await app.user.type(composer, "Keep my follow-up");
    expect(composer).toHaveProperty("value", "Keep my follow-up");
    await app.waitForView(() => expect(app.elementByTestId(dataTestId.sendMessage)).toHaveProperty("disabled", false));
    app.transport.disconnect();
    await app.waitForView(() => expect(app.elementByTestId(dataTestId.sendMessage)).toHaveProperty("disabled", true));
    expect(reconnectStatusText(app)).toBeNull();
    await app.user.keyboard("{Enter}");
    expect(composer).toHaveProperty("value", "Keep my follow-up");
    expect(app.optionalElementByTestId(dataTestId.queuedMessage)).toBeNull();
    await act(async () => {
        app.transport.open();
        clock.advanceBy(5000);
    });
    await app.waitForView(() => expect(app.elementByTestId(dataTestId.sendMessage)).toHaveProperty("disabled", false));
    expect(reconnectStatusText(app)).toBeNull();
    expect(composer).toHaveProperty("value", "Keep my follow-up");
    await app.user.keyboard("{Enter}");
    await app.queryElementByTestId(
        dataTestId.queuedMessage,
        (element) => element.textContent?.includes("Keep my follow-up") === true,
    );
});

test("Given a queued follow-up on an active turn, When the Computer drops and the retry notice appears, Then the notice joins the flow and the queue stays visible", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock(CLOCK_ORIGIN);
    const app = await createTestApp({ connectAgent: true, clock });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "wait for steering");
    await app.queryElementByTestId(dataTestId.sessionStatus);
    await app.waitForView(() =>
        getByRole(document.body, "button", { name: /Switch computer/, description: "Connection available" }),
    );
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Queue this follow-up");
    await app.queryElementByTestId(
        dataTestId.queuedMessage,
        (element) => element.textContent?.includes("Queue this follow-up") === true,
    );
    if (app.daemon === null) {
        throw new Error("Expected the connected Computer");
    }
    await app.daemon.disconnect();
    await showReconnectNotice(app, clock);
    // With a queue block between the log and the composer, a floating notice would
    // be lifted over it and clipped by the pane; the in-flow notice stacks instead.
    const notices = app.elementsByTestId(dataTestId.sessionReconnectNotice);
    expect(notices).toHaveLength(1);
    expect(noticePlacement(app)).toBe("in-flow");
    expect(
        app
            .elementsByTestId(dataTestId.queuedMessage)
            .some((element) => element.textContent?.includes("Queue this follow-up")),
    ).toBe(true);
});
