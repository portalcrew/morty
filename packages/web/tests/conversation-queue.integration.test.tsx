import { resolveObjectURL } from "node:buffer";
import { createClientPayloadEncryption } from "@morty-build/client";
import { sessionOperationFailedEventCodec } from "@morty-build/client/protocol";
import { fireEvent, getAllByText, getByLabelText, getByRole, queryAllByText, queryByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import * as v from "valibot";
import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { readyComposer, sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";
import { createChatWorkerEnvironment, dedicatedEnvironmentTimeout } from "./support/chat-worker.ts";

test("Given a running turn, When I queue a message before the Computer receives it, Then it stays visible exactly once through admission and execution", {
    timeout: dedicatedEnvironmentTimeout,
}, async () => {
    const environment = await createChatWorkerEnvironment(false, true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true });
    const { daemon, executionNetwork } = app;
    if (daemon === null || executionNetwork === null) {
        throw new Error("Expected a real Computer and the execution transport proxy");
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "wait for steering");
    await app.queryElementByTestId(dataTestId.sessionStatus);
    const instruction = "Keep this queued instruction visible";
    await app.waitForView(() => expect(document.body.textContent).toContain("Waiting for steering"));
    const held = executionNetwork.holdNextSubmission();
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), instruction);
    const release = await held;
    try {
        await app.waitForView(() => expect(getAllByText(document.body, instruction)).toHaveLength(1));
    } finally {
        release();
    }
    await app.waitForView(() => {
        getByLabelText(document.body, `Edit queued message: ${instruction}`);
        expect(getAllByText(document.body, instruction)).toHaveLength(1);
    });
    await daemon.continueReply("wait for steering", { outcome: "complete", output: [] });
    await app.waitForView(() => {
        expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull();
        expect(app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toEqual([
            "wait for steering",
            instruction,
        ]);
        expect(getAllByText(document.body, instruction)).toHaveLength(1);
    });
    await app.close();
});

for (const eventOrder of ["before refusal", "after refusal"] as const) {
    test(`Given a released Computer starts queued work before a delayed steer arrives, When its lifecycle arrives ${eventOrder}, Then the completed reply has no stale queue error`, {
        timeout: dedicatedEnvironmentTimeout,
    }, async () => {
        const environment = await createChatWorkerEnvironment(false, true);
        onTestFinished(() => environment.close());
        const app = await createTestApp({ environment, connectAgent: true });
        const { daemon, executionNetwork } = app;
        if (daemon === null || executionNetwork === null) {
            throw new Error("Expected a real Computer and the execution transport proxy");
        }
        await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "wait for steering");
        await app.queryElementByTestId(dataTestId.sessionStatus);
        await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "hold after first delta");
        const queued = await app.queryElementByTestId(dataTestId.queuedMessage);
        const held = executionNetwork.holdNextSteer();
        await app.user.click(getByLabelText(queued, "Steer queued message: hold after first delta"));
        const release = await held;
        const releaseEvents = eventOrder === "after refusal" ? executionNetwork.holdSessionEvents() : () => {};
        try {
            await daemon.continueReply("wait for steering", { outcome: "complete", output: [] });
            // This control waits for the queued prompt to reach the real ACP harness before continuing it.
            await daemon.continueReply("hold after first delta", {
                outcome: "hold",
                output: [{ kind: "text", text: "Queued work is now running" }],
            });
            if (eventOrder === "before refusal") {
                await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.queuedMessage)).toBeNull());
            }
            // The Computer refuses the late steer because the message already left the queue.
            const response = v.parse(
                v.object({ kind: v.literal("http.response"), status: v.literal(200), body: v.string() }),
                await release(),
            );
            const signal = AbortSignal.timeout(10_000);
            const encryption = await createClientPayloadEncryption(await daemon.encryptionAccess(signal), signal);
            try {
                expect(await sessionOperationFailedEventCodec.decode(response.body, encryption, signal)).toMatchObject({
                    kind: "session.operation.failed",
                    code: "turn_already_started",
                    message: "The message already left the queue and could not be steered",
                });
            } finally {
                encryption.close();
            }
            if (eventOrder === "after refusal") {
                await app.waitForView(() =>
                    expect(document.body.textContent).toContain(
                        "The message already left the queue and could not be steered",
                    ),
                );
            }
        } finally {
            releaseEvents();
        }
        await daemon.continueReply("hold after first delta", {
            outcome: "complete",
            output: [{ kind: "text", text: "Queued work completed after the late steer" }],
        });
        await app.waitForView(() =>
            expect(
                app
                    .elementsByTestId(dataTestId.agentResponse)
                    .some((element) => element.textContent?.includes("Queued work completed after the late steer")),
            ).toBe(true),
        );
        await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
        expect(document.body.textContent).not.toContain("The local agent operation could not be completed");
        expect(app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toEqual([
            "wait for steering",
            "hold after first delta",
        ]);
        await app.close();
    });
}

test("Given queued work starts before its delayed withdrawal, When I edit it and the Computer refuses, Then the running instruction is not restored to my composer", {
    timeout: dedicatedEnvironmentTimeout,
}, async () => {
    const environment = await createChatWorkerEnvironment(false, true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true });
    const { daemon, executionNetwork } = app;
    if (daemon === null || executionNetwork === null) {
        throw new Error("Expected the real Computer and ordering proxy");
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "wait for steering");
    await app.waitForView(() => expect(document.body.textContent).toContain("Waiting for steering"));
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "hold after first delta");
    const queued = await app.queryElementByTestId(dataTestId.queuedMessage);
    await app.user.click(app.elementByTestId(dataTestId.messageComposer));
    await app.user.paste("My next draft");
    const held = executionNetwork.holdNextQueuedCancellation();
    await app.user.click(getByLabelText(queued, "Edit queued message: hold after first delta"));
    const release = await held;
    const releaseEvents = executionNetwork.holdSessionEvents();
    try {
        await daemon.continueReply("wait for steering", { outcome: "complete", output: [] });
        await daemon.continueReply("hold after first delta", {
            outcome: "hold",
            output: [{ kind: "text", text: "The queued instruction is running" }],
        });
        await release();
        await app.waitForView(() => {
            expect(document.body.textContent).toContain("The message already started and could not be withdrawn");
            expect(app.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", "My next draft");
        });
        expect(document.body.textContent).not.toContain("Its text is back in the composer");
    } finally {
        releaseEvents();
    }
    await daemon.continueReply("hold after first delta", { outcome: "complete", output: [] });
    await app.waitForView(() => {
        expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull();
        expect(app.optionalElementByTestId(dataTestId.queuedMessage)).toBeNull();
        expect(app.elementsByTestId(dataTestId.userMessage).map((message) => message.textContent)).toEqual([
            "wait for steering",
            "hold after first delta",
        ]);
    });
    expect(app.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", "My next draft");
});

test("Given the daemon has queued work, When the user steers it into the active turn, Then every viewer sees the steered reply", {
    timeout: 30_000,
}, async () => {
    const instruction = "Use the revised requirement";
    const deletedInstruction = "Add a footer that should be deleted";
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, "wait for steering");
    await app.queryElementByTestId(dataTestId.sessionStatus);
    const viewer = await app.openViewer();
    await viewer.queryElementByTestId(dataTestId.sessionStatus);
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), instruction);
    const queued = await viewer.queryElementByTestId(
        dataTestId.queuedMessage,
        (element) => element.textContent?.includes(instruction) === true,
    );
    for (const current of [app, viewer]) {
        expect(
            current
                .elementsByTestId(dataTestId.userMessage)
                .some((element) => element.textContent?.includes(instruction) === true),
        ).toBe(false);
    }
    await viewer.user.click(getByLabelText(queued, `Steer queued message: ${instruction}`));
    for (const current of [app, viewer]) {
        await current.waitForView(() =>
            expect(
                current
                    .elementsByTestId(dataTestId.agentResponse)
                    .some((element) => element.textContent?.includes("Waiting for steering") === true),
            ).toBe(true),
        );
        await current.waitForView(() =>
            expect(
                current
                    .elementsByTestId(dataTestId.agentResponse)
                    .some((element) => element.textContent?.includes(`Steered: ${instruction}`) === true),
            ).toBe(true),
        );
        await current.waitForView(() => expect(current.optionalElementByTestId(dataTestId.queuedMessage)).toBeNull());
        await current.queryElementByTestId(dataTestId.sessionStatus);
        await current.waitForView(() =>
            expect(current.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toEqual([
                "wait for steering",
                instruction,
            ]),
        );
        expect(
            current
                .elementsByTestId(dataTestId.agentReplyStatus)
                .some((element) => element.textContent?.includes("steered") === true),
        ).toBe(false);
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), deletedInstruction);
    const queuedForDeletion = await viewer.queryElementByTestId(
        dataTestId.queuedMessage,
        (element) => element.textContent?.includes(deletedInstruction) === true,
    );
    await viewer.user.click(getByLabelText(queuedForDeletion, `Delete queued message: ${deletedInstruction}`));
    for (const current of [app, viewer]) {
        await current.waitForView(() => expect(current.optionalElementByTestId(dataTestId.queuedMessage)).toBeNull());
        await current.queryElementByTestId(dataTestId.sessionStatus);
        await current.waitForView(() => {
            expect(queryAllByText(document.body, deletedInstruction)).toHaveLength(0);
            expect(
                current
                    .elementsByTestId(dataTestId.userMessage)
                    .some((element) => element.textContent?.includes(deletedInstruction) === true),
            ).toBe(false);
            expect(
                current
                    .elementsByTestId(dataTestId.agentReplyStatus)
                    .some((element) => element.textContent?.includes("cancelled") === true),
            ).toBe(false);
        });
    }
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    await daemon.continueReply("wait for steering", { outcome: "complete", output: [] });
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    await viewer.close();
});

test("Given a follow-up is queued, When the user stops the active turn, Then the started follow-up appears in the message list", {
    timeout: 30_000,
}, async () => {
    const activePrompt = "wait for steering";
    const queuedPrompt = "Explain Golang ==";
    const app = await createTestApp({ connectAgent: true, agent: { harness: "pi", label: "Pi" } });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, activePrompt);
    await app.queryElementByTestId(
        dataTestId.sendMessage,
        (element) => element.getAttribute("aria-label") === "Stop agent output",
    );
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), queuedPrompt);
    await app.queryElementByTestId(
        dataTestId.queuedMessage,
        (element) => element.textContent?.includes(queuedPrompt) === true,
    );

    await app.user.click(
        await app.queryElementByTestId(
            dataTestId.sendMessage,
            (element) => element.getAttribute("aria-label") === "Stop agent output",
        ),
    );

    await app.waitForView(() =>
        expect(app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toEqual([
            activePrompt,
            queuedPrompt,
        ]),
    );
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
});

test("Given a follow-up queued in a running Session starts while I view another Session, When I return, Then it shows once in the message list and no longer in the queue", {
    timeout: dedicatedEnvironmentTimeout,
}, async () => {
    const queuedPrompt = "hold after first delta";
    const environment = await createChatWorkerEnvironment(false, true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true });
    const { daemon } = app;
    if (daemon === null) {
        throw new Error("Expected a real Computer");
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "wait for steering");
    await app.waitForView(() => expect(document.body.textContent).toContain("Waiting for steering"));
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), queuedPrompt);
    await app.queryElementByTestId(dataTestId.queuedMessage);
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    const running = await app.waitForView(() => {
        const entry = app
            .elementsByTestId(dataTestId.managedConversation)
            .find((element) => element.textContent?.includes("wait for steering"));
        if (entry === undefined) {
            throw new Error("Expected the running Session in the directory");
        }
        return entry;
    });

    await daemon.continueReply("wait for steering", { outcome: "complete", output: [] });
    await daemon.continueReply(queuedPrompt, {
        outcome: "hold",
        output: [{ kind: "text", text: "The follow-up is running" }],
    });
    await app.user.click(running);

    await app.waitForView(() => {
        expect(document.body.textContent).toContain("The follow-up is running");
        expect(app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toEqual([
            "wait for steering",
            queuedPrompt,
        ]);
        expect(queryByRole(document.body, "region", { name: "Queued messages" })).toBeNull();
        expect(getAllByText(document.body, queuedPrompt)).toHaveLength(1);
    });
    await daemon.continueReply(queuedPrompt, { outcome: "complete", output: [] });
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    await app.close();
});

test("Given a follow-up is queued and the user has started another draft, When they edit the queued follow-up, Then it leaves the queue and returns to the composer ahead of the draft", {
    timeout: 30_000,
}, async () => {
    const queuedPrompt = "Use the revised requirement";
    const draft = "Also keep the footer";
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "wait for steering");
    await app.queryElementByTestId(dataTestId.sessionStatus);
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), queuedPrompt);
    const queued = await app.queryElementByTestId(
        dataTestId.queuedMessage,
        (element) => element.textContent?.includes(queuedPrompt) === true,
    );
    await app.user.click(await app.queryElementByTestId(dataTestId.messageComposer));
    await app.user.paste(draft);

    await app.user.click(getByLabelText(queued, `Edit queued message: ${queuedPrompt}`));

    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.queuedMessage)).toBeNull());
    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", `${queuedPrompt}\n\n${draft}`),
    );
    expect(document.body.textContent).not.toContain("Files attached to this message");
});

test("Given I edit a queued follow-up, When I open another Session before the Computer withdraws it, Then its text is back in that Session's composer when I return", {
    timeout: dedicatedEnvironmentTimeout,
}, async () => {
    const queuedPrompt = "Rewrite the queued follow-up";
    const environment = await createChatWorkerEnvironment(false, true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true });
    const { daemon, executionNetwork } = app;
    if (daemon === null || executionNetwork === null) {
        throw new Error("Expected a real Computer and the execution transport proxy");
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "wait for steering");
    await app.waitForView(() => expect(document.body.textContent).toContain("Waiting for steering"));
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), queuedPrompt);
    const queued = await app.queryElementByTestId(
        dataTestId.queuedMessage,
        (element) => element.textContent?.includes(queuedPrompt) === true,
    );
    const held = executionNetwork.holdNextQueuedCancellation();
    await app.user.click(getByLabelText(queued, `Edit queued message: ${queuedPrompt}`));
    const release = await held;

    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.queuedMessage)).toBeNull());
    // The Computer withdraws the message only after the user left its Session.
    expect(await release()).toMatchObject({ kind: "http.response", status: 200 });
    const running = await app.waitForView(() => {
        const entry = app
            .elementsByTestId(dataTestId.managedConversation)
            .find((element) => element.textContent?.includes("wait for steering"));
        if (entry === undefined) {
            throw new Error("Expected the running Session in the directory");
        }
        return entry;
    });
    await app.user.click(running);

    await app.waitForView(() => {
        expect(app.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", queuedPrompt);
        expect(app.optionalElementByTestId(dataTestId.queuedMessage)).toBeNull();
        expect(document.body.textContent).toContain("Waiting for steering");
    });
    await daemon.continueReply("wait for steering", { outcome: "complete", output: [] });
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    expect(app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toEqual([
        "wait for steering",
    ]);
    await app.close();
});

test("Given a reply is running with a queued follow-up, When I edit the follow-up, Then all viewers keep the reply running and only the revised message executes", {
    timeout: 30_000,
}, async () => {
    const queuedPrompt = "OLD_QUEUED_INSTRUCTION";
    const revisedPrompt = "REVISED_QUEUED_INSTRUCTION";
    const app = await createTestApp({ connectAgent: true });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "wait for steering");
    await app.queryElementByTestId(dataTestId.sessionStatus);
    const viewer = await app.openViewer();
    await viewer.queryElementByTestId(dataTestId.sessionStatus);
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), queuedPrompt);
    const queued = await app.queryElementByTestId(
        dataTestId.queuedMessage,
        (element) => element.textContent?.includes(queuedPrompt) === true,
    );

    await app.user.click(getByLabelText(queued, `Edit queued message: ${queuedPrompt}`));

    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", queuedPrompt),
    );
    for (const current of [app, viewer]) {
        await current.waitForView(() => expect(current.optionalElementByTestId(dataTestId.queuedMessage)).toBeNull());
        expect(current.optionalElementByTestId(dataTestId.sessionStatus)).not.toBeNull();
        expect(
            current.elementsByTestId(dataTestId.agentReplyStatus).map((element) => element.textContent),
        ).not.toContain("Turn stopped.");
    }
    if (app.daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    await app.daemon.continueReply("wait for steering", {
        outcome: "complete",
        output: [{ kind: "text", text: "Original reply completed" }],
    });
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    await app.user.clear(app.elementByTestId(dataTestId.messageComposer));
    await sendPrompt(app, app.elementByTestId(dataTestId.messageComposer), revisedPrompt);
    for (const current of [app, viewer]) {
        await current.waitForView(() =>
            expect(
                current
                    .elementsByTestId(dataTestId.agentResponse)
                    .some((item) => item.textContent?.includes(revisedPrompt)),
            ).toBe(true),
        );
        expect(current.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toEqual([
            "wait for steering",
            revisedPrompt,
        ]);
        expect(
            current.elementsByTestId(dataTestId.agentResponse).some((item) => item.textContent?.includes(queuedPrompt)),
        ).toBe(false);
    }
    await viewer.close();
});

test("Given two queued submissions are accepted before their snapshot arrives, When I switch Sessions then edit and resend, Then the original file is restored and delivered", {
    timeout: dedicatedEnvironmentTimeout,
}, async () => {
    const queuedPrompt = "Describe the queued image";
    const imageBytes = Uint8Array.from(
        atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4oKAAAAM0ATE4/UtcAAAAAElFTkSuQmCC"),
        (character) => character.charCodeAt(0),
    );
    const environment = await createChatWorkerEnvironment(false, true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "wait for steering");
    await app.queryElementByTestId(dataTestId.sessionStatus);
    await readyComposer(app);
    await app.waitForView(() =>
        expect(getByLabelText(document.body, "Choose attachments")).toHaveProperty("disabled", false),
    );
    await app.user.upload(
        getByLabelText(document.body, "Choose attachments"),
        new File([imageBytes], "queued.png", { type: "image/png" }),
    );
    await app.waitForView(() =>
        expect(getByRole(document.body, "list", { name: "Attachments" }).textContent).toContain("queued.png"),
    );
    if (app.executionNetwork === null) {
        throw new Error("Expected the real execution-read proxy");
    }
    const held = app.executionNetwork.holdNextExecution();
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), queuedPrompt);
    const release = await held;
    await app.waitForView(() => {
        expect(app.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", "");
        expect(queryByRole(document.body, "list", { name: "Attachments" })).toBeNull();
    });

    try {
        // Admission releases the composer while the first queue snapshot is still held.
        await app.user.click(app.elementByTestId(dataTestId.messageComposer));
        await app.user.paste("Refresh the queue");
        const send = await app.waitForView(() => {
            const button = getByRole(document.body, "button", { name: "Send message" });
            expect(button.hasAttribute("disabled")).toBe(false);
            return button;
        });
        await app.user.click(send);
        await app.waitForView(() =>
            expect(app.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", ""),
        );
    } finally {
        release();
    }
    await app.waitForView(() => expect(app.elementsByTestId(dataTestId.queuedMessage)).toHaveLength(2));
    await app.waitForView(() => expect(app.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", ""));
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    const previous = await app.waitForView(() => {
        const entry = app
            .elementsByTestId(dataTestId.managedConversation)
            .find((element) => element.textContent?.includes("wait for steering"));
        if (entry === undefined) {
            throw new Error("Expected the running Session in the directory");
        }
        return entry;
    });
    await app.user.click(previous);
    await app.waitForView(() => expect(app.elementsByTestId(dataTestId.queuedMessage)).toHaveLength(2));
    await app.user.click(getByLabelText(document.body, `Edit queued message: ${queuedPrompt}`));
    await app.waitForView(() => {
        expect(app.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", queuedPrompt);
        expect(getByRole(document.body, "list", { name: "Attachments" }).textContent).toContain("queued.png");
    });
    expect(document.body.textContent).not.toContain("Files attached to this message could not be restored here.");

    if (app.daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    await app.daemon.continueReply("wait for steering", { outcome: "complete", output: [] });
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    await app.user.click(getByRole(document.body, "button", { name: "Send message" }));
    const source = await app.waitForView(() => {
        expect(
            app.elementsByTestId(dataTestId.agentResponse).some((item) => item.textContent?.includes(queuedPrompt)),
        ).toBe(true);
        const message = app
            .elementsByTestId(dataTestId.userMessage)
            .find((item) => item.textContent?.includes(queuedPrompt));
        expect(message).toBeDefined();
        const source = getByRole(document.body, "img", { name: "Your attachment" }).getAttribute("src");
        expect(source?.startsWith("blob:")).toBe(true);
        return source;
    });
    const image = source === null ? undefined : resolveObjectURL(source);
    if (image === undefined) {
        throw new Error("Expected the delivered attachment image");
    }
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(imageBytes);
});

test("Given a follow-up with a file was queued from another browser, When this viewer edits it, Then its text returns and Chat explains that the file must be added again", {
    timeout: 30_000,
}, async () => {
    const queuedPrompt = "Summarize the attached notes";
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "wait for steering");
    await app.queryElementByTestId(dataTestId.sessionStatus);
    const viewer = await app.openViewer();
    await viewer.queryElementByTestId(dataTestId.sessionStatus);
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement) || composer.form === null) {
        throw new Error("Expected the message composer form");
    }
    const form = composer.form;
    await app.user.click(composer);
    await app.user.paste(queuedPrompt);
    act(() => {
        fireEvent.change(getByLabelText(form, "Choose attachments"), {
            target: { files: [new File(["Attachment contents"], "notes.txt", { type: "text/plain" })] },
        });
    });
    await app.waitForView(() =>
        expect(getByRole(form, "list", { name: "Attachments" }).textContent).toContain("notes.txt"),
    );
    await app.user.click(getByRole(form, "button", { name: "Send message" }));
    const queued = await viewer.queryElementByTestId(
        dataTestId.queuedMessage,
        (element) => element.textContent?.includes(queuedPrompt) === true,
    );

    await viewer.user.click(getByLabelText(queued, `Edit queued message: ${queuedPrompt}`));

    const viewerComposer = viewer.elementByTestId(dataTestId.messageComposer);
    if (!(viewerComposer instanceof HTMLTextAreaElement) || viewerComposer.form === null) {
        throw new Error("Expected the viewer's message composer form");
    }
    const viewerForm = viewerComposer.form;
    await viewer.waitForView(() => expect(viewerComposer).toHaveProperty("value", queuedPrompt));
    expect(viewerForm.querySelector('[aria-label="Attachments"]')).toBeNull();
    await viewer.waitForView(() =>
        expect(document.body.textContent).toContain("Files attached to this message could not be restored here."),
    );
    // A later attachment failure takes over the headline; the standing explanation
    // about the queued file must stay visible as its detail, or the draft could be
    // sent without those files and with no explanation.
    act(() => {
        fireEvent.change(getByLabelText(viewerForm, "Choose attachments"), {
            target: { files: [new File([], "empty.txt", { type: "text/plain" })] },
        });
    });
    await viewer.waitForView(() => expect(document.body.textContent).toContain("Files must be between 1 byte"));
    expect(document.body.textContent).toContain("Files attached to this message could not be restored here.");

    // Leaving the Session and returning opens a new pane on it; the edited message and its explanation stay.
    const edited = viewerComposer.value;
    const sessionId = new URL(window.location.href).searchParams.get("sessionId");
    expect(sessionId).not.toBeNull();
    await viewer.user.click(await viewer.queryElementByTestId(dataTestId.newConversation));
    await viewer.waitForView(() =>
        expect(document.body.textContent).not.toContain("Files attached to this message could not be restored here."),
    );
    // This scenario has one Session. Its native title need not equal its first prompt.
    const conversation = await viewer.queryElementByTestId(dataTestId.managedConversation);
    await viewer.user.click(conversation);
    await viewer.waitForView(() => {
        expect(new URL(window.location.href).searchParams.get("sessionId")).toBe(sessionId);
        expect(viewer.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", edited);
        expect(document.body.textContent).toContain("Files attached to this message could not be restored here.");
    });
});

test("Given a viewer is loading running history, When another viewer stops before its execution read, Then the partial reply retains its stopped notice", {
    timeout: dedicatedEnvironmentTimeout,
}, async () => {
    const environment = await createChatWorkerEnvironment(false, true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "wait for steering");
    await app.queryElementByTestId(dataTestId.sessionStatus);
    if (app.executionNetwork === null) {
        throw new Error("Expected a real execution-read proxy");
    }
    const held = app.executionNetwork.holdNextExecution();
    const viewer = await app.openViewer();
    const release = await held;
    try {
        await app.user.click(
            await app.queryElementByTestId(
                dataTestId.sendMessage,
                (element) => element.getAttribute("aria-label") === "Stop agent output",
            ),
        );
        await app.waitForView(() =>
            expect(app.elementsByTestId(dataTestId.agentReplyStatus).map((element) => element.textContent)).toContain(
                "Turn stopped.",
            ),
        );
    } finally {
        release();
    }
    await viewer.waitForView(() =>
        expect(viewer.elementsByTestId(dataTestId.agentReplyStatus).map((element) => element.textContent)).toContain(
            "Turn stopped.",
        ),
    );
    expect(
        viewer
            .elementsByTestId(dataTestId.agentResponse)
            .some((element) => element.textContent?.includes("Waiting for steering")),
    ).toBe(true);
    await viewer.close();
    await app.close();
});

test("Given a viewer is loading history before seeing a queue item, When another viewer withdraws that item, Then the running reply never gains a stopped notice", {
    timeout: dedicatedEnvironmentTimeout,
}, async () => {
    const environment = await createChatWorkerEnvironment(false, true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "wait for steering");
    await app.queryElementByTestId(dataTestId.sessionStatus);
    await sendPrompt(
        app,
        await app.queryElementByTestId(dataTestId.messageComposer),
        "WITHDRAW_BEFORE_VIEWER_RECONCILES",
    );
    const queued = await app.queryElementByTestId(dataTestId.queuedMessage);
    if (app.executionNetwork === null || app.daemon === null) {
        throw new Error("Expected a connected Computer and real execution-read proxy");
    }
    const held = app.executionNetwork.holdNextExecution();
    const viewer = await app.openViewer();
    const release = await held;
    try {
        await app.user.click(getByLabelText(queued, "Edit queued message: WITHDRAW_BEFORE_VIEWER_RECONCILES"));
        await app.waitForView(() =>
            expect(app.elementByTestId(dataTestId.messageComposer)).toHaveProperty(
                "value",
                "WITHDRAW_BEFORE_VIEWER_RECONCILES",
            ),
        );
    } finally {
        release();
    }
    await viewer.queryElementByTestId(dataTestId.sessionStatus);
    await app.daemon.continueReply("wait for steering", {
        outcome: "complete",
        output: [{ kind: "text", text: "Original reply completed after withdrawal" }],
    });
    await viewer.waitForView(() =>
        expect(
            viewer
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Original reply completed after withdrawal")),
        ).toBe(true),
    );
    expect(viewer.elementsByTestId(dataTestId.agentReplyStatus).map((element) => element.textContent)).not.toContain(
        "Turn stopped.",
    );
    expect(viewer.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toEqual([
        "wait for steering",
    ]);
    await viewer.close();
    await app.close();
});
