import { getByLabelText, getByRole, queryAllByLabelText, queryByRole } from "@testing-library/dom";
import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { refreshSessions, sendPrompt, showReconnectNotice } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";
import { createChatWorkerEnvironment, dedicatedEnvironmentTimeout } from "./support/chat-worker.ts";

test("Given a running message whose admission response was lost, When Chat reconnects, Then delivery is confirmed without retrying or waiting for completion", {
    timeout: dedicatedEnvironmentTimeout,
}, async () => {
    const environment = await createChatWorkerEnvironment(true);
    onTestFinished(() => environment.close());
    const clock = new TestClock("2026-10-28T08:00:00Z");
    const app = await createTestApp({ environment, connectAgent: true, clock });
    const network = app.network;
    if (network === null || app.daemon === null) {
        throw new Error("Expected the response-loss network and connected Computer");
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Established session");
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Established session");
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
    });
    network.interruptNextTurn("after-acceptance");
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "hold after first delta");
    await app.waitForView(() => getByRole(document.body, "button", { name: "Retry message with unknown delivery" }));
    const submissions = network.submissions.length;
    await showReconnectNotice(app, clock);
    network.reconnect();
    await app.user.click(await app.waitForView(() => getByRole(document.body, "button", { name: "Retry now" })));
    await app.waitForView(() => {
        expect(app.optionalElementByTestId(dataTestId.sessionReconnectNotice)).toBeNull();
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Partial reply")),
        ).toBe(true);
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).not.toBeNull();
        expect(queryByRole(document.body, "button", { name: "Retry message with unknown delivery" })).toBeNull();
    });
    expect(network.submissions).toHaveLength(submissions);
    expect(
        app
            .elementsByTestId(dataTestId.userMessage)
            .filter((element) => element.textContent?.includes("hold after first delta")),
    ).toHaveLength(1);
    await app.user.click(getByRole(document.body, "button", { name: "Stop agent output" }));
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull());
});

for (const message of ["first", "subsequent"] as const) {
    test(`Given an unconfirmed ${message} message with an attachment, When Chat remounts and I retry, Then the original submission is delivered once`, {
        timeout: dedicatedEnvironmentTimeout,
    }, async () => {
        const environment = await createChatWorkerEnvironment(true);
        onTestFinished(() => environment.close());
        const clock = new TestClock("2026-10-28T08:00:00Z");
        const app = await createTestApp({ environment, connectAgent: true, clock });
        const network = app.network;
        if (network === null) {
            throw new Error("Expected the response-loss network");
        }
        if (message === "subsequent") {
            await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Established session");
            await app.waitForView(() => {
                expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain(
                    "Established session",
                );
                expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
            });
        }
        const composer = await app.queryElementByTestId(dataTestId.messageComposer);
        await app.user.upload(
            getByLabelText(document.body, "Choose attachments"),
            new File(["Keep this attachment"], "pending.json", { type: "text/plain" }),
        );
        await app.waitForView(() =>
            expect(getByRole(document.body, "list", { name: "Attachments" }).textContent).toContain("pending.json"),
        );
        network.interruptNextTurn("before-acceptance");
        await sendPrompt(app, composer, "Retain this uncertain submission");
        await app.waitForView(() =>
            getByRole(document.body, "button", { name: "Retry message with unknown delivery" }),
        );
        const original = await app.readSubmission(network.submissions.at(-1));
        const submissions = network.submissions.length;
        await showReconnectNotice(app, clock);
        network.reconnect();
        await app.user.click(await app.waitForView(() => getByRole(document.body, "button", { name: "Retry now" })));
        await app.waitForView(() =>
            getByRole(document.body, "button", { name: /Switch computer/, description: "Connection available" }),
        );
        expect(app.optionalElementByTestId(dataTestId.sessionReconnectNotice)).toBeNull();

        const nextDraft = app.elementByTestId(dataTestId.messageComposer);
        await app.user.click(nextDraft);
        await app.user.paste("Next draft survives retry");
        app.remount();
        const retry = await app.waitForView(() => {
            const button = getByRole(document.body, "button", { name: "Retry message with unknown delivery" });
            expect(button.hasAttribute("disabled")).toBe(false);
            return button;
        });
        expect(document.body.textContent).toContain("Retain this uncertain submission");
        expect(document.body.textContent).toContain("pending.json");
        expect(network.submissions).toHaveLength(submissions);
        await app.user.click(retry);
        await app.waitForView(() => {
            expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain(
                "Retain this uncertain submission",
            );
            expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
        });
        expect(network.submissions).toHaveLength(submissions + 1);
        expect(await app.readSubmission(network.submissions.at(-1))).toEqual(original);
        expect(app.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", "Next draft survives retry");
        expect(queryByRole(document.body, "button", { name: "Retry message with unknown delivery" })).toBeNull();
    });
}

test("Given a message on its way to the Computer, When Chat remounts, Then it is delivered once and its reply arrives without asking to retry", {
    timeout: dedicatedEnvironmentTimeout,
}, async () => {
    const environment = await createChatWorkerEnvironment(true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true });
    const network = app.network;
    if (network === null) {
        throw new Error("Expected the response-loss network");
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Established session");
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Established session");
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
    });
    network.holdNextTurn();
    const arriving = network.nextSubmission(AbortSignal.timeout(15_000));
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Survive the remount");
    expect((await app.readSubmission(await arriving)).prompt).toBe("Survive the remount");
    const submissions = network.submissions.length;

    app.remount();
    const sent = () =>
        app
            .elementsByTestId(dataTestId.userMessage)
            .filter((element) => element.textContent?.includes("Survive the remount"));
    await app.waitForView(() => expect(sent()).toHaveLength(1));
    expect(queryByRole(document.body, "button", { name: "Retry message with unknown delivery" })).toBeNull();
    network.releaseHeldTurn();
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Survive the remount");
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
    });
    expect(network.submissions).toHaveLength(submissions);
    expect(sent()).toHaveLength(1);
    expect(queryByRole(document.body, "button", { name: "Retry message with unknown delivery" })).toBeNull();
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

test("Given another client used my pending message identity, When the Computer refuses steering and my submission, Then retry creates a new message identity instead of recovering unknown delivery", {
    timeout: dedicatedEnvironmentTimeout,
}, async () => {
    const environment = await createChatWorkerEnvironment(true, true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true });
    const { daemon, network, executionNetwork } = app;
    if (daemon === null || network === null || executionNetwork === null) {
        throw new Error("Expected the real Computer and controllable network");
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Established session");
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Established session");
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
    });
    const sessionId = new URL(window.location.href).searchParams.get("sessionId");
    if (sessionId === null) {
        throw new Error("Expected an open Session");
    }
    network.holdNextTurn();
    const arriving = network.nextSubmission(AbortSignal.timeout(15_000));
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "My pending instruction");
    const original = await app.readSubmission(await arriving);
    const releaseEvents = executionNetwork.holdSessionEvents();
    try {
        await daemon.submitTurn(sessionId, "wait for steering", original.commandId);
        await expect(daemon.steerTurn(sessionId, original.commandId)).rejects.toMatchObject({
            name: "MortyOperationError",
            code: "turn_already_started",
            outcome: "refused",
        });
        await daemon.continueReply("wait for steering", { outcome: "complete", output: [] });
        network.releaseHeldTurn();
        const retry = await app.waitForView(() => getByRole(document.body, "button", { name: "Retry message" }));
        expect(queryByRole(document.body, "button", { name: "Retry message with unknown delivery" })).toBeNull();
        await app.user.click(app.elementByTestId(dataTestId.messageComposer));
        await app.user.paste("My next draft");
        await app.user.click(retry);
    } finally {
        releaseEvents();
    }
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("My pending instruction");
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
    });
    const retried = await app.readSubmission(network.submissions.at(-1));
    expect(retried.commandId).not.toBe(original.commandId);
    expect(retried.prompt).toBe(original.prompt);
    expect(app.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", "My next draft");
    expect(app.elementsByTestId(dataTestId.userMessage).map((message) => message.textContent)).toEqual([
        "Established session",
        "wait for steering",
        "My pending instruction",
    ]);
});

test("Given completed Sessions on one Computer, When I switch between them and New Session, Then one browser connection carries Computer requests, history and new replies", {
    timeout: dedicatedEnvironmentTimeout,
}, async () => {
    const environment = await createChatWorkerEnvironment(true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true });
    const network = app.network;
    if (network === null) {
        throw new Error("Expected the observable network boundary");
    }
    for (const title of [
        "First completed Session",
        "Second completed Session",
        "Third completed Session",
        "Fourth completed Session",
    ]) {
        await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), title);
        await app.waitForView(() => {
            expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain(title);
            expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
        });
        await network.waitForBrowserConnections(1, AbortSignal.timeout(10_000));
        expect(network.browserConnectionsOpened).toBe(1);
        await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    }
    for (const title of ["First completed Session", "Fourth completed Session", "First completed Session"]) {
        await app.user.click(await app.waitForView(() => sessionEntry(app, title)));
        await app.waitForView(() => {
            const messages = getByRole(document.body, "log", { name: "Messages" }).textContent;
            expect(messages).toContain(title);
            expect(messages).not.toContain(
                title === "First completed Session" ? "Fourth completed Session" : "First completed Session",
            );
            expect(app.elementByTestId(dataTestId.messageComposer)).toHaveProperty("disabled", false);
        });
        expect(network.browserConnectionsOpened).toBe(1);
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Reply after switching");
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Reply after switching");
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
    });
    expect(network.browserConnectionsOpened).toBe(1);
    await app.close();
    await network.waitForBrowserConnections(0, AbortSignal.timeout(10_000));
});

test("Given a message the network has not delivered yet, When I switch to another Session, it finishes in the background and I switch back, Then it shows once with its reply and I can keep chatting", {
    timeout: dedicatedEnvironmentTimeout,
}, async () => {
    const environment = await createChatWorkerEnvironment(true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true });
    const network = app.network;
    const daemon = app.daemon;
    if (network === null || daemon === null) {
        throw new Error("Expected the controllable network and connected Computer");
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Established session");
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Established session");
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
    });
    network.holdNextTurn();
    const arriving = network.nextSubmission(AbortSignal.timeout(15_000));
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "hold after first delta");
    expect((await app.readSubmission(await arriving)).prompt).toBe("hold after first delta");
    const submissions = network.submissions.length;

    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    network.releaseHeldTurn();
    await daemon.continueReply("hold after first delta", {
        outcome: "complete",
        output: [{ kind: "text", text: "Finished while you were away" }],
    });
    await refreshSessions(app);
    await app.waitForView(() =>
        expect(
            sessionEntry(app, "Established session")
                .querySelector(`[data-testid="${dataTestId.sessionStatus}"]`)
                ?.getAttribute("aria-label"),
        ).toBe("Unread response"),
    );

    await app.user.click(sessionEntry(app, "Established session"));
    const composer = await app.waitForView(() => {
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
            "Finished while you were away",
        );
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
            .filter((element) => element.textContent?.includes("hold after first delta")),
    ).toHaveLength(1);
    expect(network.submissions).toHaveLength(submissions);
    await sendPrompt(app, composer, "Keep chatting");
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Keep chatting");
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
    });
});

test("Given a message whose file is still uploading, When I switch to New Session and back, Then the message is delivered and its reply arrives", {
    timeout: 60_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Session that sends a file");
    await app.waitForView(() => {
        expect(document.body.textContent).toContain("Codex turn 1: Session that sends a file");
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
        sessionEntry(app, "Session that sends a file");
    });
    await app.user.upload(
        getByLabelText(document.body, "Choose attachments"),
        new File(["attachment body ".repeat(4096)], "photo.txt", { type: "text/plain" }),
    );
    // Leave the moment the message shows as sending, while its file is still on its way.
    let left = false;
    const observer = new MutationObserver(() => {
        if (!left && queryAllByLabelText(document.body, "Sending message").length > 0) {
            left = true;
            app.elementByTestId(dataTestId.newConversation).click();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    onTestFinished(() => observer.disconnect());
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Look at this file");
    await app.waitForView(() => expect(left).toBe(true));
    observer.disconnect();
    await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );

    await app.user.click(sessionEntry(app, "Session that sends a file"));
    await app.waitForView(() => {
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
            "Codex turn 2: Look at this file",
        );
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
    });
    expect(document.body.textContent).not.toContain("Message preparation was interrupted");
    expect(
        app
            .elementsByTestId(dataTestId.userMessage)
            .filter((element) => element.textContent?.includes("Look at this file")),
    ).toHaveLength(1);
});
