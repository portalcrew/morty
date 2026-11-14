import { resolveObjectURL } from "node:buffer";
import { getByLabelText, getByRole, queryByLabelText, queryByRole } from "@testing-library/dom";
import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { readyComposer, sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

const REMOVE_ATTACHMENT = 'button[aria-label="Remove notes.json"]';

test("Given a first prompt with an attachment, When it creates the conversation, Then the message being sent cannot be edited and arrives whole", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const composer = await readyComposer(app);
    await app.user.upload(
        getByLabelText(document.body, "Choose attachments"),
        new File(["Attachment contents"], "notes.json", { type: "text/plain" }),
    );
    await app.waitForView(() =>
        expect(getByRole(document.body, "list", { name: "Attachments" }).textContent).toContain("notes.json"),
    );

    // From the send on, the queued message is shown as sent. Nothing may offer to remove its attachment, since a
    // removal could not change what is sent.
    let removableWhileSending = false;
    let sending = false;
    const observer = new MutationObserver(() => {
        if (!sending) {
            return;
        }
        for (const button of document.querySelectorAll(REMOVE_ATTACHMENT)) {
            if (button instanceof HTMLButtonElement && !button.disabled) {
                removableWhileSending = true;
            }
        }
    });
    observer.observe(document.body, { attributes: true, childList: true, subtree: true });
    const startSending = (event: Event): void => {
        if (event.target instanceof Element && event.target.closest(`[data-testid="${dataTestId.sendMessage}"]`)) {
            sending = true;
        }
    };
    document.addEventListener("click", startSending, { capture: true });
    onTestFinished(() => {
        observer.disconnect();
        document.removeEventListener("click", startSending, { capture: true });
    });
    await sendPrompt(app, composer, "Read the attached notes");
    expect(sending).toBe(true);

    await app.waitForView(() => {
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Read the attached notes")),
        ).toBe(true);
        expect(getByRole(document.body, "link", { name: "Download notes.json" }).hasAttribute("download")).toBe(true);
    });
    const source = getByRole(document.body, "link", { name: "Download notes.json" }).getAttribute("href");
    const attachment = source === null ? undefined : resolveObjectURL(source);
    expect(await attachment?.text()).toBe("Attachment contents");
    observer.disconnect();
    expect(removableWhileSending).toBe(false);
    expect(document.querySelector(REMOVE_ATTACHMENT)).toBeNull();
});

test("Given an attachment upload is rejected before turn submission, When I send my first message, Then the failed message remains recoverable without replacing my next draft", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const composer = await readyComposer(app);
    const name = `${"notes".repeat(101)}.json`;
    await app.user.upload(
        getByLabelText(document.body, "Choose attachments"),
        new File(["Attachment contents"], name, { type: "text/plain" }),
    );
    await app.waitForView(() =>
        expect(getByRole(document.body, "list", { name: "Attachments" }).textContent).toContain(name),
    );
    await sendPrompt(app, composer, "Keep this unsent message");
    await app.waitForView(() => {
        expect(getByRole(document.body, "alert").textContent).not.toBe("");
        const draft = app.elementByTestId(dataTestId.messageComposer);
        expect(draft).toBeInstanceOf(HTMLTextAreaElement);
        if (!(draft instanceof HTMLTextAreaElement)) {
            throw new Error("Expected an editable composer");
        }
        expect(draft.disabled).toBe(false);
        expect(draft.value).toBe("");
        expect(getByRole(document.body, "button", { name: "Edit failed message" })).toHaveProperty("disabled", false);
    });
    const next = app.elementByTestId(dataTestId.messageComposer);
    await app.user.click(next);
    await app.user.paste("My next draft");
    await app.user.click(getByRole(document.body, "button", { name: "Edit failed message" }));
    expect(next).toHaveProperty("value", "Keep this unsent message\n\nMy next draft");
    expect(getByRole(document.body, "button", { name: `Remove ${name}` })).toHaveProperty("disabled", false);
});

test("Given my message whose attachment upload was rejected, When I discard it, Then neither the composer nor the sidebar still reports the failure", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const composer = await readyComposer(app);
    const name = `${"notes".repeat(101)}.json`;
    await app.user.upload(
        getByLabelText(document.body, "Choose attachments"),
        new File(["Attachment contents"], name, { type: "text/plain" }),
    );
    await sendPrompt(app, composer, "Discard this unsent message");
    const discard = await app.waitForView(() => {
        expect(queryByLabelText(document.body, "Session failed")).not.toBeNull();
        return getByRole(document.body, "button", { name: "Discard failed message" });
    });

    await app.user.click(discard);

    await app.waitForView(() => {
        expect(queryByRole(document.body, "button", { name: "Discard failed message" })).toBeNull();
        expect(queryByRole(document.body, "alert")).toBeNull();
        expect(queryByLabelText(document.body, "Session failed")).toBeNull();
    });
});
