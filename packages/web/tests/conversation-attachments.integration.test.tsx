import { fireEvent, getAllByRole, getByLabelText, getByRole, queryByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { readyComposer, sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

async function renderedImageBytes(sources: readonly (string | null)[]): Promise<readonly Uint8Array[]> {
    return await Promise.all(
        sources.map(async (source) => {
            const blob = source === null ? undefined : resolveObjectURL(source);
            if (blob === undefined) {
                throw new Error("Expected a loaded attachment image");
            }
            return new Uint8Array(await blob.arrayBuffer());
        }),
    );
}

test("Given text and two images in one user message, When the conversation reloads, Then its chunks remain one message and later prompts stay separate", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    const image = (data: string, name: string) =>
        new File([Uint8Array.from(atob(data), (character) => character.charCodeAt(0))], name, { type: "image/png" });
    await app.user.upload(getByLabelText(document.body, "Choose attachments"), [
        image(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4oKAAAAM0ATE4/UtcAAAAAElFTkSuQmCC",
            "red.png",
        ),
        image(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQcPgAAAHUAVE//8MXAAAAAElFTkSuQmCC",
            "blue.png",
        ),
    ]);
    const prompt = "Keep these images together";
    await sendPrompt(app, composer, prompt);
    const sources = await app.waitForView(() => {
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((response) => response.textContent?.includes(`Codex turn 1: ${prompt}`)),
        ).toBe(true);
        expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull();
        expect(getAllByRole(document.body, "article", { name: "Your message" })).toHaveLength(1);
        const message = getByRole(document.body, "article", { name: "Your message" });
        expect(message.textContent).toContain(prompt);
        const images = getAllByRole(document.body, "img", { name: "Your attachment" });
        expect(images).toHaveLength(2);
        const sources = images.map((image) => image.getAttribute("src"));
        expect(sources.every((source) => source?.startsWith("blob:") === true)).toBe(true);
        expect(new Set(sources).size).toBe(2);
        return sources;
    });

    const originalImages = await renderedImageBytes(sources);
    const reloaded = await app.reload();
    const reloadedSources = await reloaded.waitForView(() => {
        expect(getAllByRole(document.body, "article", { name: "Your message" })).toHaveLength(1);
        const message = getByRole(document.body, "article", { name: "Your message" });
        expect(message.textContent).toContain(prompt);
        const images = getAllByRole(document.body, "img", { name: "Your attachment" });
        expect(images).toHaveLength(2);
        const result = images.map((image) => image.getAttribute("src"));
        expect(result.every((source) => source?.startsWith("blob:") === true)).toBe(true);
        expect(result).not.toEqual(sources);
        return result;
    });
    expect(await renderedImageBytes(reloadedSources)).toEqual(originalImages);
    const followUp = "A separate message";
    await sendPrompt(reloaded, await reloaded.queryElementByTestId(dataTestId.messageComposer), followUp);
    await reloaded.waitForView(() => expect(document.body.textContent).toContain(`Codex turn 2: ${followUp}`));
    const reopened = await reloaded.reload();
    const reopenedSources = await reopened.waitForView(() => {
        const messages = getAllByRole(document.body, "article", { name: "Your message" });
        expect(messages).toHaveLength(2);
        expect(messages[0]?.textContent).toContain(prompt);
        expect(messages[1]?.textContent).toContain(followUp);
        const images = getAllByRole(document.body, "img", { name: "Your attachment" });
        expect(images).toHaveLength(2);
        expect(images.every((image) => image.getAttribute("src")?.startsWith("blob:") === true)).toBe(true);
        return images.map((image) => image.getAttribute("src"));
    });
    expect(await renderedImageBytes(reopenedSources)).toEqual(originalImages);
});

test("Given the message composer, When the user clicks Add attachment and selects a file, Then the picker opens directly and the attachment appears", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(dataTestId.messageComposer);
    let pickerOpened = false;
    const observePicker = (event: Event) => {
        if (event.target instanceof HTMLInputElement && event.target.type === "file") {
            pickerOpened = true;
        }
    };
    document.addEventListener("click", observePicker);
    try {
        await app.user.click(getByRole(document.body, "button", { name: /^Add(?: attachment)?$/ }));
    } finally {
        document.removeEventListener("click", observePicker);
    }
    expect(pickerOpened).toBe(true);
    expect(queryByRole(document.body, "menu")).toBeNull();
    const input = getByLabelText(document.body, "Choose attachments");
    await app.user.upload(input, new File(["Attachment contents"], "notes.json", { type: "text/plain" }));
    await app.waitForView(() =>
        expect(getByRole(document.body, "list", { name: "Attachments" }).textContent).toContain("notes.json"),
    );
    await app.user.click(getByRole(document.body, "button", { name: "Remove notes.json" }));
    expect(queryByRole(document.body, "list", { name: "Attachments" })).toBeNull();
});

test("Given an image larger than the former limit, When the user attaches it, Then the composer accepts it", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(dataTestId.messageComposer);
    const input = getByLabelText(document.body, "Choose attachments");
    await app.user.upload(input, new File([new Uint8Array(3_000_000)], "large-image.png", { type: "image/png" }));
    await app.waitForView(() =>
        expect(getByRole(document.body, "list", { name: "Attachments" }).textContent).toContain("large-image.png"),
    );
});

test("Given an Agent is running, When the user reads an attachment and immediately stops output, Then cancellation remains available before the file read finishes", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, "hold after first delta");
    await app.waitForView(() => expect(document.body.textContent).toContain("Partial reply"));
    await app.waitForView(() => getByRole(document.body, "button", { name: "Stop agent output" }));
    // Flush the reading state without yielding to asynchronous FileReader completion.
    act(() => {
        fireEvent.change(getByLabelText(document.body, "Choose attachments"), {
            target: { files: [new File(["Next message"], "next.json", { type: "text/plain" })] },
        });
    });
    expect(getByRole(document.body, "button", { name: "Add attachment" }).hasAttribute("disabled")).toBe(true);
    const stop = getByRole(document.body, "button", { name: "Stop agent output" });
    expect(stop.hasAttribute("disabled")).toBe(false);
    act(() => {
        fireEvent.click(stop);
    });
    await app.waitForView(() => {
        expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull();
        expect(queryByRole(document.body, "button", { name: "Stop agent output" })).toBeNull();
    });
    expect(document.body.textContent).toContain("Partial reply");
});

test("Given a draft attachment, When Chat remounts, Then the attachment remains until the user starts a new conversation", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(dataTestId.messageComposer);
    await app.user.upload(
        getByLabelText(document.body, "Choose attachments"),
        new File(["Keep this draft"], "draft.json", { type: "text/plain" }),
    );
    await app.waitForView(() =>
        expect(getByRole(document.body, "list", { name: "Attachments" }).textContent).toContain("draft.json"),
    );
    app.remount();
    await app.queryElementByTestId(dataTestId.messageComposer);
    expect(getByRole(document.body, "list", { name: "Attachments" }).textContent).toContain("draft.json");
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    expect(queryByRole(document.body, "list", { name: "Attachments" })).toBeNull();
});

test("Given an existing Session draft, When Chat remounts during an attachment read, Then its text and attachments remain until removed", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true, sessionIds: new Set(["draft-lifetime"]) });
    await app.user.click(await app.waitForView(() => getByRole(document.body, "button", { name: "Open Session" })));
    const dialog = await app.waitForView(() => getByRole(document.body, "dialog", { name: "Open Session" }));
    // The first entry is previewed automatically; reselecting it can overlap that Computer operation.
    await app.waitForView(() =>
        expect(getByRole(dialog, "button", { name: "Native draft-lifetime" }).getAttribute("aria-pressed")).toBe(
            "true",
        ),
    );
    await app.waitForView(() => getByRole(dialog, "heading", { name: "Native draft-lifetime" }));
    await app.user.click(getByRole(dialog, "button", { name: "Open" }));
    await app.waitForView(() => expect(queryByRole(document.body, "dialog", { name: "Open Session" })).toBeNull());
    const composer = await readyComposer(app);
    await app.user.click(composer);
    await app.user.paste("Keep this unsent draft");
    const input = getByLabelText(document.body, "Choose attachments");
    await app.user.upload(input, new File(["Already read"], "first.json", { type: "text/plain" }));
    await app.waitForView(() =>
        expect(getByRole(document.body, "list", { name: "Attachments" }).textContent).toContain("first.json"),
    );
    // Detach before the second asynchronous file read can complete.
    act(() => {
        fireEvent.change(input, {
            target: { files: [new File(["Still reading"], "second.json", { type: "text/plain" })] },
        });
        app.remount();
    });
    await app.waitForView(() => getByRole(document.body, "heading", { name: "Native draft-lifetime" }));
    const restored = await readyComposer(app);
    if (!(restored instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    expect(restored.value).toBe("Keep this unsent draft");
    await app.waitForView(() => {
        const attachments = getByRole(document.body, "list", { name: "Attachments" });
        expect(attachments.textContent).toContain("first.json");
        expect(attachments.textContent).toContain("second.json");
    });
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    expect(queryByRole(document.body, "list", { name: "Attachments" })).toBeNull();
    await app.user.click(await app.queryElementByTestId(dataTestId.managedConversation));
    const reopened = await readyComposer(app);
    if (!(reopened instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the reopened message composer");
    }
    expect(reopened.value).toBe("Keep this unsent draft");
    await app.user.click(getByRole(document.body, "button", { name: "Remove first.json" }));
    await app.user.click(getByRole(document.body, "button", { name: "Remove second.json" }));
    expect(queryByRole(document.body, "list", { name: "Attachments" })).toBeNull();
    expect(reopened.value).toBe("Keep this unsent draft");
});

test("Given an attachment is being read, When the user removes an earlier attachment, Then completing the read preserves that removal", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(dataTestId.messageComposer);
    const input = getByLabelText(document.body, "Choose attachments");
    await app.user.upload(input, new File(["Remove this"], "removed.json", { type: "text/plain" }));
    await app.waitForView(() =>
        expect(getByRole(document.body, "list", { name: "Attachments" }).textContent).toContain("removed.json"),
    );
    // Both user events happen before asynchronous file I/O can complete.
    act(() => {
        fireEvent.change(input, { target: { files: [new File(["Keep this"], "added.json", { type: "text/plain" })] } });
        fireEvent.click(getByRole(document.body, "button", { name: "Remove removed.json" }));
    });
    await app.waitForView(() => {
        const attachments = getByRole(document.body, "list", { name: "Attachments" });
        expect(attachments.textContent).toContain("added.json");
        expect(attachments.textContent).not.toContain("removed.json");
    });
});

test("Given an SVG file, When the user sends it with a prompt, Then the Agent replies and the file is shown as an image whose URL cannot open as a Morty page", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3"/></svg>';
    await app.user.upload(
        getByLabelText(document.body, "Choose attachments"),
        new File([svg], "diagram.svg", { type: "image/svg+xml" }),
    );

    const prompt = "Inspect this SVG file";
    await sendPrompt(app, composer, prompt);
    await app.waitForView(() => expect(document.body.textContent).toContain(`Codex turn 1: ${prompt}`));
    const reloaded = await app.reload();
    const source = await reloaded.waitForView(() => {
        expect(document.body.textContent).toContain(prompt);
        const image = getByRole(document.body, "img", { name: "Your attachment" });
        return image.getAttribute("src") ?? "";
    });

    // A data URL opens with an opaque origin, so the SVG's own script can never run with Morty's stored access.
    const prefix = "data:image/svg+xml;base64,";
    expect(source.startsWith(prefix)).toBe(true);
    expect(Uint8Array.from(atob(source.slice(prefix.length)), (character) => character.charCodeAt(0))).toEqual(
        new TextEncoder().encode(svg),
    );
});

test("Given a PDF file, When the user sends it with a prompt, Then the Agent replies and the file can be downloaded", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    const pdf = new TextEncoder().encode("%PDF-1.7\n% Morty attachment\n");
    await app.user.upload(
        getByLabelText(document.body, "Choose attachments"),
        new File([pdf], "document.pdf", { type: "application/pdf" }),
    );

    const prompt = "Inspect this PDF file";
    await sendPrompt(app, composer, prompt);
    await app.waitForView(() => expect(document.body.textContent).toContain(`Codex turn 1: ${prompt}`));
    const reloaded = await app.reload();
    const source = await reloaded.waitForView(() => {
        expect(document.body.textContent).toContain(prompt);
        const link = getByRole(document.body, "link", { name: "Download document.pdf" });
        expect(link.hasAttribute("download")).toBe(true);
        return link.getAttribute("href");
    });

    expect(await renderedImageBytes([source])).toEqual([pdf]);
});

import { resolveObjectURL } from "node:buffer";
