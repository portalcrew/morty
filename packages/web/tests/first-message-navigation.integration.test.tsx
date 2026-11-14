import { getByRole } from "@testing-library/dom";
import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { readyComposer, sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

function answered(app: TestApp, text: string): boolean {
    return app.elementsByTestId(dataTestId.agentResponse).some((element) => element.textContent?.includes(text));
}

function conversationEntry(app: TestApp, title: string): HTMLElement | undefined {
    return app
        .elementsByTestId(dataTestId.managedConversation)
        .find((element) => element.textContent?.includes(title) === true);
}

const moments = [
    {
        name: "while its conversation is being created",
        reached: () =>
            document.querySelector(
                `[data-testid="${dataTestId.initialMessageStatus}"] [aria-label="Sending message"]`,
            ) !== null,
    },
    {
        name: "as soon as its conversation appears",
        reached: (app: TestApp, prompt: string) => conversationEntry(app, prompt) !== undefined,
    },
] as const;

for (const moment of moments) {
    test(`Given another conversation, When I send the first prompt of a new one and switch away ${moment.name}, Then the new conversation still receives that prompt`, {
        timeout: 60_000,
    }, async () => {
        const app = await createTestApp({ connectAgent: true });
        const composer = await readyComposer(app);
        await sendPrompt(app, composer, "Keep the earlier conversation");
        await app.waitForView(() => expect(answered(app, "Codex turn 1: Keep the earlier conversation")).toBe(true));
        await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
        await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));

        // The user goes back to the earlier conversation before the new conversation has connected and sent its
        // first prompt.
        const prompt = "Start the new conversation";
        let switched = false;
        const observer = new MutationObserver(() => {
            if (switched || !moment.reached(app, prompt)) {
                return;
            }
            const earlier = conversationEntry(app, "Keep the earlier conversation");
            if (earlier !== undefined) {
                switched = true;
                earlier.click();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        onTestFinished(() => observer.disconnect());
        const draft = await readyComposer(app);
        await sendPrompt(app, draft, prompt);
        await app.waitForView(() => expect(switched).toBe(true));
        observer.disconnect();
        await app.waitForView(() => expect(answered(app, "Codex turn 1: Keep the earlier conversation")).toBe(true));

        const created = await app.waitForView(() => {
            const entry = conversationEntry(app, prompt);
            if (entry === undefined) {
                throw new Error("The new conversation is not listed");
            }
            return entry;
        });
        await app.user.click(created);
        await app.waitForView(() => expect(answered(app, `Codex turn 1: ${prompt}`)).toBe(true), 20_000);
    });
}

test("Given a first prompt whose conversation is still being created, When I start another new conversation with the same text, Then the new draft keeps its text after the first conversation is created", {
    timeout: 60_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const prompt = "Draft this twice";
    let restarted = false;
    const observer = new MutationObserver(() => {
        if (
            !restarted &&
            document.querySelector(
                `[data-testid="${dataTestId.initialMessageStatus}"] [aria-label="Sending message"]`,
            ) !== null
        ) {
            restarted = true;
            app.elementByTestId(dataTestId.newConversation).click();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    onTestFinished(() => observer.disconnect());
    const composer = await readyComposer(app);
    await sendPrompt(app, composer, prompt);
    await app.waitForView(() => expect(restarted).toBe(true));
    observer.disconnect();
    // The new draft gets the same text before the first conversation is created.
    const draft = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled && element.value === "",
    );
    await app.user.click(draft);
    await app.user.paste(prompt);

    await app.waitForView(() => expect(conversationEntry(app, prompt)).toBeDefined());
    const current = app.elementByTestId(dataTestId.messageComposer);
    expect(current instanceof HTMLTextAreaElement ? current.value : null).toBe(prompt);
});

test("Given a first message whose Session is still being created, When I open another Session and the creation fails, Then the message returns to the New Session draft", {
    timeout: 60_000,
}, async () => {
    let creation = Promise.withResolvers<void>();
    let holding = false;
    onTestFinished(() => creation.resolve());
    const app = await createTestApp({
        connectAgent: true,
        agent: {
            harness: "settings-test",
            label: "Settings Agent",
            beforeSessionCreated: async () => {
                if (holding) {
                    holding = false;
                    await creation.promise;
                }
            },
        },
    });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Earlier conversation");
    await app.waitForView(() => {
        expect(document.body.textContent).toContain("Settings Agent: Earlier conversation");
        expect(conversationEntry(app, "Earlier conversation")).toBeDefined();
    });
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    const draft = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled && element.value === "",
    );
    creation = Promise.withResolvers<void>();
    void creation.promise.catch(() => undefined);
    holding = true;
    await sendPrompt(app, draft, "My carefully written first message");
    await app.waitForView(() =>
        getByRole(app.elementByTestId(dataTestId.queuedMessage), "status", { name: "Sending message" }),
    );

    const earlier = conversationEntry(app, "Earlier conversation");
    if (earlier === undefined) {
        throw new Error("Expected the earlier conversation in the sidebar");
    }
    await app.user.click(earlier);
    await app.waitForView(() => expect(document.body.textContent).toContain("Settings Agent: Earlier conversation"));
    creation.reject(new Error("The controlled Agent could not create a Session"));

    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.messageComposer)).toHaveProperty(
            "value",
            "My carefully written first message",
        ),
    );
    expect(conversationEntry(app, "My carefully written first message")).toBeUndefined();
});

test("Given two first messages whose Sessions were being created, When both creations fail and the page reloads, Then both messages return to the New Session draft", {
    timeout: 60_000,
}, async () => {
    const creations: PromiseWithResolvers<void>[] = [];
    let holding = false;
    onTestFinished(() => {
        for (const creation of creations) {
            creation.resolve();
        }
    });
    const app = await createTestApp({
        connectAgent: true,
        agent: {
            harness: "settings-test",
            label: "Settings Agent",
            beforeSessionCreated: async () => {
                if (holding) {
                    const creation = Promise.withResolvers<void>();
                    void creation.promise.catch(() => undefined);
                    creations.push(creation);
                    await creation.promise;
                }
            },
        },
    });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Earlier conversation");
    await app.waitForView(() => {
        expect(document.body.textContent).toContain("Settings Agent: Earlier conversation");
        expect(conversationEntry(app, "Earlier conversation")).toBeDefined();
    });
    holding = true;
    for (const message of ["First unsent message", "Second unsent message"]) {
        await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
        const draft = await app.queryElementByTestId(
            dataTestId.messageComposer,
            (element) => element instanceof HTMLTextAreaElement && !element.disabled && element.value === "",
        );
        await sendPrompt(app, draft, message);
        await app.waitForView(() =>
            getByRole(app.elementByTestId(dataTestId.queuedMessage), "status", { name: "Sending message" }),
        );
    }
    const earlier = conversationEntry(app, "Earlier conversation");
    if (earlier === undefined) {
        throw new Error("Expected the earlier conversation in the sidebar");
    }
    await app.user.click(earlier);
    await app.waitForView(() => expect(document.body.textContent).toContain("Settings Agent: Earlier conversation"));
    expect(creations).toHaveLength(2);
    for (const creation of creations) {
        creation.reject(new Error("The controlled Agent could not create a Session"));
    }

    const reloaded = await app.reload();
    await reloaded.user.click(await reloaded.queryElementByTestId(dataTestId.newConversation));
    await reloaded.waitForView(() => {
        const composer = reloaded.elementByTestId(dataTestId.messageComposer);
        expect(composer).toHaveProperty("value", expect.stringContaining("First unsent message"));
        expect(composer).toHaveProperty("value", expect.stringContaining("Second unsent message"));
    });
});
