import { getByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { interactiveHtml } from "../../../tests/support/fake-daemon/html-preview.ts";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given a link to a text file of a type Morty does not name, When the user opens it, Then its source is previewed", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected Computer");
    }
    await daemon.writeFiles(
        new Map([
            [
                "/workspace/src/App.vue",
                { content: "<template>\n  <p>Delivery review</p>\n</template>\n", mediaType: "text/plain" },
            ],
        ]),
    );
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "wait for steering");
    await app.waitForView(() => expect(document.body.textContent).toContain("Waiting for steering"));
    await daemon.continueReply("wait for steering", {
        outcome: "complete",
        output: [{ kind: "text", text: "\n\n[Open component](src/App.vue)\n\n" }],
    });
    await app.user.click(await app.waitForView(() => getByRole(document.body, "button", { name: "Open component" })));
    const preview = await app.queryElementByTestId(dataTestId.filePreview);
    await app.waitForView(() =>
        expect(getByRole(preview, "region", { name: "File contents" }).textContent).toContain("Delivery review"),
    );
});

test("Given a local file link in an active response, When more output arrives during a click, Then the link still opens its preview", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected Computer");
    }
    await daemon.writeFiles(new Map([["/workspace/index.html", { content: interactiveHtml, mediaType: "text/html" }]]));
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "hold after first delta");
    await app.waitForView(() => expect(document.body.textContent).toContain("Partial reply"));
    await daemon.continueReply("hold after first delta", {
        outcome: "hold",
        output: [{ kind: "text", text: "\n\n[Open result](index.html)\n\n" }],
    });
    const link = await app.waitForView(() => getByRole(document.body, "button", { name: "Open result" }));
    await app.user.pointer({ keys: "[MouseLeft>]", target: link });
    await daemon.continueReply("hold after first delta", {
        outcome: "hold",
        output: [{ kind: "text", text: "More output arrived." }],
    });
    await app.waitForView(() => expect(document.body.textContent).toContain("More output arrived."));
    await app.user.pointer({
        keys: "[/MouseLeft]",
        target: getByRole(document.body, "button", { name: "Open result" }),
    });
    const preview = await app.queryElementByTestId(dataTestId.filePreview);
    await app.user.click(await app.waitForView(() => getByRole(preview, "button", { name: "View source" })));
    await app.waitForView(() =>
        expect(getByRole(preview, "region", { name: "File contents" }).textContent).toContain("Delivery review"),
    );
    await daemon.continueReply("hold after first delta", { outcome: "complete", output: [] });
});
