import { RequestError } from "@agentclientprotocol/sdk/unstable";
import { getByLabelText, getByRole, queryByRole } from "@testing-library/dom";
import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";
import { createChatWorkerEnvironment, dedicatedEnvironmentTimeout } from "./support/chat-worker.ts";

test("Given a slow Session creation, When I send text and an attachment and write the next draft, Then the submitted message appears once and the new draft survives the handoff", {
    timeout: 30_000,
}, async () => {
    const gate = Promise.withResolvers<void>();
    let holding = false;
    onTestFinished(() => gate.resolve());
    const app = await createTestApp({
        connectAgent: true,
        agent: {
            harness: "settings-test",
            label: "Settings Agent",
            beforeSessionCreated: async () => {
                if (holding) {
                    await gate.promise;
                }
            },
        },
    });
    const composer = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    await app.user.upload(
        getByLabelText(document.body, "Choose attachments"),
        new File(["First attachment"], "first.json", { type: "text/plain" }),
    );
    await app.waitForView(() => getByRole(document.body, "button", { name: "Remove first.json" }));
    await app.user.click(composer);
    await app.user.paste("Read the first attachment");
    const send = await app.waitForView(() => {
        const button = getByRole(document.body, "button", { name: "Send message" });
        expect(button).toHaveProperty("disabled", false);
        return button;
    });
    holding = true;
    await app.user.click(send);
    expect(composer).toHaveProperty("value", "");
    expect(composer).toHaveProperty("disabled", false);
    expect(queryByRole(document.body, "button", { name: "Remove first.json" })).toBeNull();
    expect(app.elementsByTestId(dataTestId.queuedMessage)).toHaveLength(1);
    await app.user.click(composer);
    await app.user.paste("My next draft");
    await app.user.upload(
        getByLabelText(document.body, "Choose attachments"),
        new File(["Next attachment"], "next.json", { type: "text/plain" }),
    );
    await app.waitForView(() => getByRole(document.body, "button", { name: "Remove next.json" }));
    await app.user.click(composer);
    gate.resolve();
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Read the first attachment")),
        ).toBe(true),
    );
    expect(app.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", "My next draft");
    expect(getByRole(document.body, "button", { name: "Remove next.json" })).toHaveProperty("disabled", false);
    expect(document.activeElement).toBe(app.elementByTestId(dataTestId.messageComposer));
    expect(app.elementsByTestId(dataTestId.userMessage)).toHaveLength(1);
    expect(app.elementsByTestId(dataTestId.userMessage)[0]?.textContent).not.toContain("next.json");
});

test.each(["refused", "unknown"] as const)(
    "Given Session creation is %s after I write another draft, When I retry, Then only a definite refusal can send the original snapshot and the next draft is preserved",
    {
        timeout: 30_000,
    },
    async (outcome) => {
        const gate = Promise.withResolvers<void>();
        void gate.promise.catch(() => undefined);
        let holding = false;
        onTestFinished(() => gate.resolve());
        const app = await createTestApp({
            connectAgent: true,
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
        });
        const composer = await app.queryElementByTestId(
            dataTestId.messageComposer,
            (element) => element instanceof HTMLTextAreaElement && !element.disabled,
        );
        await app.user.click(composer);
        await app.user.paste("Retry this original message");
        const send = await app.waitForView(() => {
            const button = getByRole(document.body, "button", { name: "Send message" });
            expect(button).toHaveProperty("disabled", false);
            return button;
        });
        holding = true;
        await app.user.click(send);
        await app.user.paste("Keep my new draft");
        gate.reject(
            outcome === "refused"
                ? RequestError.invalidParams("The controlled Agent refused Session creation before admission")
                : new Error("The Agent failed without establishing whether creation completed"),
        );
        const retry = await app.waitForView(() => getByRole(document.body, "button", { name: "Retry message" }));
        expect(app.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", "Keep my new draft");
        expect(app.elementsByTestId(dataTestId.userMessage)).toHaveLength(1);
        await app.user.click(retry);
        if (outcome === "unknown") {
            await app.waitForView(() => getByRole(document.body, "button", { name: "Retry message" }));
            expect(app.elementsByTestId(dataTestId.agentResponse)).toHaveLength(0);
            expect(app.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", "Keep my new draft");
            expect(app.elementsByTestId(dataTestId.userMessage)).toHaveLength(1);
            return;
        }
        await app.waitForView(() =>
            expect(
                app
                    .elementsByTestId(dataTestId.agentResponse)
                    .some((element) => element.textContent?.includes("Retry this original message")),
            ).toBe(true),
        );
        expect(app.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", "Keep my new draft");
        expect(app.elementsByTestId(dataTestId.userMessage)).toHaveLength(1);
    },
);

test("Given an existing Session and a held submission, When I send a message and attach a file to my next draft before acknowledgement, Then the message appears once and its completion never clears the new text or file", {
    timeout: dedicatedEnvironmentTimeout,
}, async () => {
    const environment = await createChatWorkerEnvironment(true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true });
    const network = app.network;
    if (network === null) {
        throw new Error("Expected the controlled network");
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Established Session");
    await app.waitForView(() =>
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Established Session"),
    );
    await app.waitForView(() => getByRole(document.body, "button", { name: "Send message" }));
    const composer = app.elementByTestId(dataTestId.messageComposer);
    network.holdNextTurn();
    const arriving = network.nextSubmission(AbortSignal.timeout(15_000));
    await sendPrompt(app, composer, "Original held message");
    expect(composer).toHaveProperty("value", "");
    expect(composer).toHaveProperty("disabled", false);
    expect((await app.readSubmission(await arriving)).prompt).toBe("Original held message");
    const submissions = network.submissions.length;
    await app.user.paste("Next text stays mine");
    await app.user.upload(
        getByLabelText(document.body, "Choose attachments"),
        new File(["Next file"], "next.json", { type: "text/plain" }),
    );
    await app.waitForView(() => getByRole(document.body, "button", { name: "Remove next.json" }));
    await app.user.click(composer);
    await app.user.keyboard("{Enter}");
    expect(network.submissions).toHaveLength(submissions);
    expect(
        app
            .elementsByTestId(dataTestId.userMessage)
            .filter((element) => element.textContent?.includes("Original held message")),
    ).toHaveLength(1);
    network.releaseHeldTurn();
    await app.waitForView(() =>
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Original held message"),
    );
    expect(composer).toHaveProperty("value", "Next text stays mine");
    expect(getByRole(document.body, "button", { name: "Remove next.json" })).toHaveProperty("disabled", false);
    expect(network.submissions).toHaveLength(submissions);
    expect(
        app
            .elementsByTestId(dataTestId.userMessage)
            .filter((element) => element.textContent?.includes("Original held message")),
    ).toHaveLength(1);
});
