import {
    fireEvent,
    getByLabelText,
    getByRole,
    queryAllByRole,
    queryAllByText,
    queryByRole,
} from "@testing-library/dom";
import { act } from "@testing-library/react";
import { flushSync } from "react-dom";
import { expect, onTestFinished, test, vi } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";
import { createChatWorkerEnvironment, dedicatedEnvironmentTimeout } from "./support/chat-worker.ts";

const recoveredFailure = "Internal error: The controlled Agent rejected this turn.";

for (const submission of ["rejected", "upload-failed"] as const) {
    test(`Given a failed turn followed by a ${submission} message, When the Computer silently reconnects, Then the latest submission result survives without reviving the old failure`, {
        timeout: 60_000,
    }, async () => {
        const app = await createTestApp({ connectAgent: true, clock: new TestClock("2026-10-28T08:00:00Z") });
        const daemon = app.daemon;
        if (daemon === null) {
            throw new Error("Expected the connected Computer");
        }
        await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Established session");
        await app.waitForView(() => {
            expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Established session");
            expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
        });
        const composer = await app.queryElementByTestId(dataTestId.messageComposer);
        const form = composer.closest("form");
        if (form === null) {
            throw new Error("Expected the composer form");
        }
        await sendPrompt(app, composer, "fail this turn explicitly");
        await app.waitForView(() => expect(entryStatus(app, "Established session")).toBe("Session failed"));
        if (submission === "upload-failed") {
            const attachmentInput = await app.waitForView(() => {
                const input = getByLabelText(document.body, "Choose attachments");
                expect(input).toHaveProperty("disabled", false);
                return input;
            });
            await app.user.upload(
                attachmentInput,
                new File(["Unsent attachment"], `${"notes".repeat(101)}.json`, { type: "text/plain" }),
            );
            await app.waitForView(() => getByRole(form, "list", { name: "Attachments" }));
        }
        // Both requests are rejected by real production validation before a new Agent turn starts.
        const prompt = submission === "rejected" ? "x".repeat(100_001) : "Keep this unsent message";
        await sendPrompt(app, composer, prompt);
        const submissionError = await app.waitForView(() => {
            expect(composer).toHaveProperty("disabled", false);
            expect(composer).toHaveProperty("value", "");
            const failedMessage = app.elementByTestId(dataTestId.queuedMessage);
            expect(failedMessage.textContent).toContain(prompt);
            const message = getByRole(failedMessage, "alert").textContent;
            expect(message).toBeTruthy();
            expect(message).not.toContain(recoveredFailure);
            return message;
        });
        const status = submission === "rejected" ? null : "Session failed";
        expect(entryStatus(app, "Established session")).toBe(status);
        await app.user.click(composer);
        await app.user.paste("Next draft survives reconnect");

        await daemon.disconnect();
        await app.waitForView(() =>
            getByRole(document.body, "button", { name: /Switch computer/, description: "Reconnecting" }),
        );
        expect(app.optionalElementByTestId(dataTestId.sessionReconnectNotice)).toBeNull();
        await daemon.reconnect();
        document.dispatchEvent(new Event("visibilitychange"));
        await app.waitForView(() =>
            expect(getByRole(document.body, "button", { name: "Retry message" })).toHaveProperty("disabled", false),
        );
        expect(app.optionalElementByTestId(dataTestId.sessionReconnectNotice)).toBeNull();
        expect(entryStatus(app, "Established session")).toBe(status);
        expect(getByRole(app.elementByTestId(dataTestId.queuedMessage), "alert").textContent).toBe(submissionError);
        expect(queryAllByText(document.body, recoveredFailure, { exact: true })).toHaveLength(0);
        expect(composer).toHaveProperty("value", "Next draft survives reconnect");
        expect(app.elementByTestId(dataTestId.queuedMessage).textContent).toContain(prompt);
    });
}

test("Given a rejected submission after an earlier failure, When another viewer's new turn fails while I am disconnected, Then reconnect recovers the new failure", {
    timeout: 60_000,
}, async () => {
    const clock = new TestClock("2026-10-28T08:00:00Z");
    const app = await createTestApp({ connectAgent: true, clock });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Established session");
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Established session");
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
    });
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    const form = composer.closest("form");
    if (form === null) {
        throw new Error("Expected the composer form");
    }
    await sendPrompt(app, composer, "fail this turn explicitly");
    await app.waitForView(() => expect(entryStatus(app, "Established session")).toBe("Session failed"));
    await sendPrompt(app, composer, "x".repeat(100_001));
    await app.waitForView(() => {
        expect(entryStatus(app, "Established session")).toBeNull();
        expect(getByRole(app.elementByTestId(dataTestId.queuedMessage), "alert").textContent).toBeTruthy();
    });
    const other = await app.openViewer();
    const otherComposer = await other.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    app.transport.disconnect();
    await app.waitForView(() =>
        expect(getByRole(form, "button", { name: "Send message" })).toHaveProperty("disabled", true),
    );
    await other.user.clear(otherComposer);
    await sendPrompt(other, otherComposer, "fail this turn explicitly");
    await other.waitForView(() => {
        expect(other.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
        expect(entryStatus(other, "Established session")).toBe("Session failed");
    });
    // Only the Chat bridge dropped: the pane's own Session stream may already show the failure.
    expect(getByRole(form, "button", { name: "Send message" })).toHaveProperty("disabled", true);
    await act(async () => {
        app.transport.open();
        clock.advanceBy(5000);
    });
    const appRoot = form.closest<HTMLElement>("[data-test-app-root]");
    if (appRoot === null) {
        throw new Error("Expected this viewer's root");
    }
    await app.waitForView(() => {
        expect(getByRole(document.body, "button", { name: "Retry message" })).toHaveProperty("disabled", false);
        // Each failed turn keeps its own failure: the earlier one and the one recovered on reconnect.
        expect(queryAllByText(appRoot, recoveredFailure, { exact: true })).toHaveLength(2);
        expect(entryStatus(app, "Established session")).toBe("Session failed");
    });
});

function sessionEntry(app: TestApp, title: string): HTMLElement {
    const entry = app
        .elementsByTestId(dataTestId.managedConversation)
        .find((element) => element.textContent?.includes(title));
    if (entry === undefined) {
        throw new Error(`Expected the ${title} Session in the sidebar`);
    }
    return entry;
}

function entryStatus(app: TestApp, title: string): string | null {
    return (
        sessionEntry(app, title)
            .querySelector(`[data-testid="${dataTestId.sessionStatus}"]`)
            ?.getAttribute("aria-label") ?? null
    );
}

test("Given a turn that fails while I am in another Session, When I return, Then I see its failure, the sidebar agrees, and my next message clears the Session's failure", {
    timeout: dedicatedEnvironmentTimeout,
}, async () => {
    const environment = await createChatWorkerEnvironment(true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true });
    const network = app.network;
    if (network === null) {
        throw new Error("Expected the controllable network");
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Established session");
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Established session");
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
    });
    network.holdNextTurn();
    const arriving = network.nextSubmission(AbortSignal.timeout(15_000));
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "fail this turn explicitly");
    expect((await app.readSubmission(await arriving)).prompt).toBe("fail this turn explicitly");

    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    network.releaseHeldTurn();
    // The turn ran and ended while another Session was selected.

    await app.user.click(sessionEntry(app, "Established session"));
    const composer = await app.waitForView(() => {
        expect(queryAllByText(document.body, recoveredFailure, { exact: true })).toHaveLength(1);
        expect(entryStatus(app, "Established session")).toBe("Session failed");
        expect(queryByRole(document.body, "button", { name: "Retry message with unknown delivery" })).toBeNull();
        const element = app.elementByTestId(dataTestId.messageComposer);
        if (!(element instanceof HTMLTextAreaElement) || element.disabled) {
            throw new Error("Expected an enabled message composer");
        }
        return element;
    });
    expect(
        app
            .elementsByTestId(dataTestId.userMessage)
            .filter((element) => element.textContent?.includes("fail this turn explicitly")),
    ).toHaveLength(1);

    await sendPrompt(app, composer, "Keep chatting");
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Keep chatting");
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
        // The failed turn keeps its failure in the conversation; the Session itself is no longer failed.
        expect(queryAllByText(document.body, recoveredFailure, { exact: true })).toHaveLength(1);
        expect(entryStatus(app, "Established session")).toBeNull();
    });
});

test("Given a Session whose last turn failed, When I reload the page, Then the sidebar still shows the Session failed", {
    timeout: dedicatedEnvironmentTimeout,
}, async () => {
    const environment = await createChatWorkerEnvironment(true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Established session");
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull());
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "fail this turn explicitly");
    await app.waitForView(() =>
        expect(queryAllByText(document.body, recoveredFailure, { exact: true })).toHaveLength(1),
    );
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    await app.waitForView(() => expect(entryStatus(app, "Established session")).toBe("Session failed"));

    // The failure is the Computer's to report, not only the memory of the page that watched it.
    const reloaded = await app.reload();
    await reloaded.waitForView(() => expect(entryStatus(reloaded, "Established session")).toBe("Session failed"));
});

test("Given my last turn completed while I was away after an earlier failure, When I return, Then the earlier turn keeps its failure and the Session is not shown failed", {
    timeout: dedicatedEnvironmentTimeout,
}, async () => {
    const environment = await createChatWorkerEnvironment(true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true });
    const network = app.network;
    if (network === null) {
        throw new Error("Expected the controllable network");
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Established session");
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull());
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "fail this turn explicitly");
    await app.waitForView(() => expect(entryStatus(app, "Established session")).toBe("Session failed"));
    network.holdNextTurn();
    const arriving = network.nextSubmission(AbortSignal.timeout(15_000));
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Finish while away");
    expect((await app.readSubmission(await arriving)).prompt).toBe("Finish while away");

    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    network.releaseHeldTurn();

    await app.user.click(sessionEntry(app, "Established session"));
    await app.waitForView(() => {
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain("Finish while away");
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
        expect(entryStatus(app, "Established session")).toBeNull();
        // Only the failed turn's own card reports a failure.
        expect(queryAllByText(document.body, recoveredFailure, { exact: true })).toHaveLength(1);
        expect(queryAllByRole(document.body, "alert")).toHaveLength(1);
    });
});

test("Given a stopped turn whose messages span two history pages, When I reopen the Session and load the older page, Then the turn still ends with its notice", {
    timeout: 90_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected the controlled Agent");
    }
    const stoppedNotices = () =>
        app.elementsByTestId(dataTestId.agentReplyStatus).filter((element) => element.textContent === "Turn stopped.");
    const reply = (turn: string) =>
        Array.from({ length: 20 }, (_, index) => ({ kind: "message" as const, text: `${turn} part ${index}.` }));
    const firstPrompt = "hold after first delta";
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), firstPrompt);
    await app.waitForView(() => expect(document.body.textContent).toContain("Partial reply"));
    await daemon.continueReply(firstPrompt, { outcome: "hold", output: reply("Turn one") });
    await app.waitForView(() => expect(document.body.textContent).toContain("Turn one part 19."));
    act(() => fireEvent.click(getByRole(document.body, "button", { name: "Stop agent output" })));
    await app.waitForView(() => expect(stoppedNotices()).toHaveLength(1));
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    const secondPrompt = "hold reasoning only";
    await sendPrompt(
        app,
        await app.queryElementByTestId(
            dataTestId.messageComposer,
            (element) => element instanceof HTMLTextAreaElement && !element.disabled,
        ),
        secondPrompt,
    );
    await daemon.continueReply(secondPrompt, { outcome: "complete", output: reply("Turn two") });
    await app.waitForView(() => expect(document.body.textContent).toContain("Turn two part 19."));
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());

    // The reopened Session's newest page holds the first turn's last messages but not its user message.
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    await app.user.click(
        await app.waitForView(() => {
            const entry = app
                .elementsByTestId(dataTestId.managedConversation)
                .find((element) => element.textContent?.includes(firstPrompt) === true);
            if (entry === undefined) {
                throw new Error(`The conversation is unavailable: ${document.body.textContent}`);
            }
            return entry;
        }),
    );
    await app.waitForView(() => {
        expect(document.body.textContent).toContain("Turn one part 19.");
        expect(app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toEqual([
            secondPrompt,
        ]);
    });

    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    onTestFinished(() => {
        vi.useRealTimers();
    });
    const messages = getByRole(document.body, "log", { name: "Messages" });
    messages.scrollTop = 0;
    flushSync(() => fireEvent.scroll(messages));
    vi.useRealTimers();
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toEqual([
            firstPrompt,
            secondPrompt,
        ]);
        const [notice] = stoppedNotices();
        const last = queryAllByText(messages, "Turn one part 19.", { exact: false }).at(-1);
        const next = app.elementsByTestId(dataTestId.userMessage).at(1);
        if (notice === undefined || last === undefined || next === undefined) {
            throw new Error(`The stopped turn's ending is missing: ${messages.textContent}`);
        }
        // The ending follows the turn's last message, before the next turn.
        expect(last.compareDocumentPosition(notice)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
        expect(notice.compareDocumentPosition(next)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
        expect(stoppedNotices()).toHaveLength(1);
    });
    await app.close();
});

test("Given a turn I steered and then stopped, When I reopen the Session, Then its ending stays after the steered reply, as it showed live", {
    timeout: 90_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected the controlled Agent");
    }
    const firstPrompt = "wait for steering";
    // The controlled Agent holds the turn after this steering, so it can be stopped.
    const instruction = "Use the revised requirement";
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), firstPrompt);
    await app.waitForView(() => expect(document.body.textContent).toContain("Waiting for steering"));
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), instruction);
    const queued = await app.queryElementByTestId(
        dataTestId.queuedMessage,
        (element) => element.textContent?.includes(instruction) === true,
    );
    await app.user.click(getByLabelText(queued, `Steer queued message: ${instruction}`));
    await app.waitForView(() => expect(document.body.textContent).toContain(`Steered: ${instruction}`));
    await app.user.click(getByRole(document.body, "button", { name: "Stop agent output" }));

    const order = () => {
        const notice = app
            .elementsByTestId(dataTestId.agentReplyStatus)
            .find((element) => element.textContent === "Turn stopped.");
        const steer = app
            .elementsByTestId(dataTestId.userMessage)
            .find((element) => element.textContent?.includes(instruction) === true);
        if (notice === undefined || steer === undefined) {
            throw new Error(`Missing notice or steer: ${document.body.textContent}`);
        }
        return notice.compareDocumentPosition(steer) === Node.DOCUMENT_POSITION_FOLLOWING
            ? "notice-before-steer"
            : "notice-after-steer";
    };
    // Live, the ending follows the whole turn, including the steered reply.
    await app.waitForView(() => expect(order()).toBe("notice-after-steer"));
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());

    // Reopened, history restates the turn's outcome and names the steering as part of that turn.
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    await app.user.click(
        await app.waitForView(() => {
            const entry = app
                .elementsByTestId(dataTestId.managedConversation)
                .find((element) => element.textContent?.includes(firstPrompt) === true);
            if (entry === undefined) {
                throw new Error(`The conversation is unavailable: ${document.body.textContent}`);
            }
            return entry;
        }),
    );
    await app.waitForView(() => expect(document.body.textContent).toContain(`Steered: ${instruction}`));
    await app.waitForView(() => expect(order()).toBe("notice-after-steer"));
    await app.close();
});
