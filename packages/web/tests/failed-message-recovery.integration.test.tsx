import { getByLabelText, getByRole, getByText, queryByRole } from "@testing-library/dom";
import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { readyComposer } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

function answered(app: TestApp, text: string): boolean {
    return app.elementsByTestId(dataTestId.agentResponse).some((element) => element.textContent?.includes(text));
}

async function editableComposer(app: TestApp): Promise<HTMLTextAreaElement> {
    const composer = await readyComposer(app);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    return composer;
}

function heldSessionCreation() {
    let gate = Promise.withResolvers<void>();
    let holding = false;
    onTestFinished(() => gate.resolve());
    return {
        hold: () => {
            gate = Promise.withResolvers<void>();
            void gate.promise.catch(() => undefined);
            holding = true;
        },
        release: () => gate.resolve(),
        reject: () =>
            gate.reject(RequestError.invalidParams("The controlled Agent refused Session creation before admission")),
        agent: {
            harness: "settings-test",
            label: "Settings Agent",
            beforeSessionCreated: async () => {
                if (holding) {
                    holding = false;
                    await gate.promise;
                }
            },
        },
    };
}

async function sendFirstMessage(app: TestApp, text: string, beforeSend: () => void = () => {}): Promise<void> {
    const composer = await editableComposer(app);
    await app.user.click(composer);
    await app.user.paste(text);
    const send = await app.waitForView(() => {
        const button = getByRole(document.body, "button", { name: "Send message" });
        expect(button).toHaveProperty("disabled", false);
        return button;
    });
    // Configuration discovery also creates a Session, so hold only the message's own creation.
    beforeSend();
    await app.user.click(send);
}

test("Given my first message is waiting for Session creation, When the creation fails, Then a failure mark replaces the sending spinner beside the message", {
    timeout: 60_000,
}, async () => {
    const creation = heldSessionCreation();
    const app = await createTestApp({ connectAgent: true, agent: creation.agent });
    await sendFirstMessage(app, "Watch my first message", creation.hold);
    const message = await app.queryElementByTestId(dataTestId.queuedMessage);
    await app.waitForView(() => getByRole(message, "status", { name: "Sending message" }));
    expect(message.textContent).not.toContain("Sending message");
    creation.reject();
    await app.waitForView(() => getByRole(message, "img", { name: "Session creation failed" }));
    expect(queryByRole(message, "status", { name: "Sending message" })).toBeNull();
    getByRole(document.body, "button", { name: "Retry message" });
});

test("Given Session creation failed for my first message, When the computer goes offline and returns, Then Retry message waits for it and then sends the message", {
    timeout: 90_000,
}, async () => {
    const creation = heldSessionCreation();
    const app = await createTestApp({ connectAgent: true, agent: creation.agent });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected computer");
    }
    await sendFirstMessage(app, "Retry once the computer returns", creation.hold);
    creation.reject();
    await app.waitForView(() => getByRole(document.body, "button", { name: "Retry message" }));
    await daemon.disconnect();
    // The Worker checks the Computer every 5 s and retries a failed check 5 s later, so one change can take two checks.
    await app.waitForView(
        () => expect(getByRole(document.body, "button", { name: "Retry message" })).toHaveProperty("disabled", true),
        20_000,
    );
    await daemon.reconnect();
    const retry = await app.waitForView(() => {
        const button = getByRole(document.body, "button", { name: "Retry message" });
        expect(button).toHaveProperty("disabled", false);
        return button;
    }, 20_000);
    await app.user.click(retry);
    await app.waitForView(() => expect(answered(app, "Retry once the computer returns")).toBe(true), 20_000);
});

test("Given Session creation failed for my first message and I wrote a next draft, When the page reloads, Then the first message returns to the composer ahead of the draft", {
    timeout: 60_000,
}, async () => {
    const creation = heldSessionCreation();
    const app = await createTestApp({ connectAgent: true, agent: creation.agent });
    await sendFirstMessage(app, "Original first message", creation.hold);
    await app.user.paste("Keep my new draft");
    creation.reject();
    await app.waitForView(() => getByRole(document.body, "button", { name: "Retry message" }));
    const reloaded = await app.reload();
    await reloaded.waitForView(() =>
        expect(reloaded.elementByTestId(dataTestId.messageComposer)).toHaveProperty(
            "value",
            "Original first message\n\nKeep my new draft",
        ),
    );
});

test("Given Session creation failed for my first message, When I start a new conversation and reload, Then the message returns to the draft once", {
    timeout: 60_000,
}, async () => {
    const creation = heldSessionCreation();
    const app = await createTestApp({ connectAgent: true, agent: creation.agent });
    await sendFirstMessage(app, "Failed first message", creation.hold);
    creation.reject();
    await app.waitForView(() => getByRole(document.body, "button", { name: "Retry message" }));
    await app.user.click(app.elementByTestId(dataTestId.newConversation));
    await app.waitForView(() => {
        expect(queryByRole(document.body, "button", { name: "Retry message" })).toBeNull();
        expect(app.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", "Failed first message");
    });
    const reloaded = await app.reload();
    await reloaded.waitForView(() =>
        expect(reloaded.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", "Failed first message"),
    );
});

test("Given my first message is waiting for Session creation, When the page reloads, Then the message returns to the composer", {
    timeout: 60_000,
}, async () => {
    const creation = heldSessionCreation();
    const app = await createTestApp({ connectAgent: true, agent: creation.agent });
    await sendFirstMessage(app, "Slow first message", creation.hold);
    await app.waitForView(() =>
        getByRole(app.elementByTestId(dataTestId.initialMessageStatus), "status", { name: "Sending message" }),
    );
    const reloaded = await app.reload();
    await reloaded.waitForView(() =>
        expect(reloaded.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", "Slow first message"),
    );
});

test("Given my first message's Session was just created, When the page reloads before the Computer takes the message, Then the message returns to that Session's composer unsent", {
    timeout: 60_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    // Reload the moment the page follows the created Session, before its pane can reach the Computer.
    const reloading = Promise.withResolvers<TestApp>();
    let reloaded = false;
    const observer = new MutationObserver(() => {
        if (!reloaded && new URL(window.location.href).searchParams.has("sessionId")) {
            reloaded = true;
            reloading.resolve(app.reload());
        }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    onTestFinished(() => observer.disconnect());
    // The reload ends the old page's interaction along with the page.
    await sendFirstMessage(app, "Message caught by the reload").catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) {
            throw cause;
        }
    });
    const page = await reloading.promise;
    observer.disconnect();
    await page.waitForView(() =>
        expect(page.elementByTestId(dataTestId.messageComposer)).toHaveProperty(
            "value",
            "Message caught by the reload",
        ),
    );
    // Unsent text is never delivered implicitly: the Session stays empty.
    await page.waitForView(() => getByText(document.body, "No message history is available for this session."));
    expect(answered(page, "Message caught by the reload")).toBe(false);
});

function conversationEntry(app: TestApp, title: string): HTMLElement | undefined {
    return app
        .elementsByTestId(dataTestId.managedConversation)
        .find((element) => element.textContent?.includes(title) === true);
}

async function openConversation(app: TestApp, title: string): Promise<HTMLTextAreaElement> {
    const entry = await app.waitForView(() => {
        const found = conversationEntry(app, title);
        if (found === undefined) {
            throw new Error(`Waiting for ${title} in the sidebar`);
        }
        return found;
    });
    await app.user.click(entry);
    await app.waitForView(() =>
        expect(
            app.elementsByTestId(dataTestId.userMessage).some((element) => element.textContent?.includes(title)),
        ).toBe(true),
    );
    return await editableComposer(app);
}

test("Given I left a new conversation while it was being created, When I attach a file there later and switch conversations, Then the file stays with that conversation", {
    timeout: 60_000,
}, async () => {
    const creation = heldSessionCreation();
    const app = await createTestApp({ connectAgent: true, agent: creation.agent });
    await sendFirstMessage(app, "Earlier conversation");
    await app.waitForView(() => expect(answered(app, "Earlier conversation")).toBe(true));
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    await sendFirstMessage(app, "Created while away", creation.hold);
    await app.waitForView(() =>
        getByRole(app.elementByTestId(dataTestId.initialMessageStatus), "status", { name: "Sending message" }),
    );
    await openConversation(app, "Earlier conversation");
    creation.release();
    const created = await openConversation(app, "Created while away");
    if (created.form === null) {
        throw new Error("Expected the message composer form");
    }
    await app.user.upload(
        getByLabelText(created.form, "Choose attachments"),
        new File(["Kept with its conversation"], "kept.json", { type: "text/plain" }),
    );
    await app.waitForView(() => getByRole(document.body, "button", { name: "Remove kept.json" }));
    await openConversation(app, "Earlier conversation");
    expect(queryByRole(document.body, "button", { name: "Remove kept.json" })).toBeNull();
    await openConversation(app, "Created while away");
    await app.waitForView(() => getByRole(document.body, "button", { name: "Remove kept.json" }));
});

import { RequestError } from "@agentclientprotocol/sdk/unstable";
