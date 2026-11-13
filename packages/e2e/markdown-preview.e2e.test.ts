import { expect, test } from "./infra/test.ts";

test("Given an agent links a Markdown file, When the user reviews it on desktop and phone, Then rendered content, source, local resources and reload work without losing their draft", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    const markdown = `# Delivery guide

Review the **finished work** before continuing.

| Item | Status |
| --- | --- |
| Preview | Ready |

- [x] Read the guide
- [ ] Request changes

> Keep the conversation moving.

\`\`\`typescript
export const ready = true;
\`\`\`

[Related notes](../notes.markdown)

![Local diagram](./diagram.svg)
`;
    await runtime.openPairedChat();
    await runtime.writeFiles(
        new Map([
            ["/workspace/docs/guide.MD", { content: markdown, mediaType: "text/plain" }],
            [
                "/workspace/docs/diagram.svg",
                {
                    content:
                        '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect width="240" height="80" fill="#dbeafe"/><text x="20" y="45" font-size="20">Local diagram</text></svg>',
                    mediaType: "image/svg+xml",
                },
            ],
            ["/workspace/notes.markdown", { content: "# Related notes\n\nReady to ship.", mediaType: "text/plain" }],
        ]),
    );
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("[Open guide](file:///workspace/docs/guide.MD)");
    await page.getByRole("button", { name: "Send message" }).click();
    const link = page
        .getByRole("article", { name: "Agent response" })
        .getByRole("button", { name: "Open guide", exact: true });
    await link.click();
    const preview = page.getByRole("dialog", { name: "Local file preview" });
    await expect(preview.getByRole("heading", { name: "Delivery guide" })).toBeVisible();
    await expect(preview.getByRole("table")).toContainText("Ready");
    await expect(preview.getByRole("checkbox").first()).toBeChecked();
    await expect(preview.getByText("export const ready = true;", { exact: true })).toBeVisible();
    const diagram = preview.getByRole("img", { name: "Local diagram", exact: true });
    await expect(diagram).toBeVisible();
    await expect(diagram).toHaveJSProperty("naturalWidth", 240);
    await preview.screenshot({ path: testInfo.outputPath("markdown-desktop.png") });

    await preview.getByRole("button", { name: "View source", exact: true }).click();
    const source = preview.getByRole("region", { name: "File contents" });
    await expect(source).toContainText("# Delivery guide");
    await expect(source).toContainText("**finished work**");
    await expect(source).toContainText("![Local diagram](./diagram.svg)");
    await expect(preview.getByRole("heading", { name: "Delivery guide" })).toBeHidden();
    await preview.getByRole("button", { name: "Show preview", exact: true }).click();
    await expect(preview.getByRole("heading", { name: "Delivery guide" })).toBeVisible();
    await preview.getByRole("button", { name: "Close file preview" }).click();
    await expect(link).toBeFocused();
    await composer.fill("Please refine the guide");

    await page.setViewportSize({ width: 390, height: 844 });
    await link.click();
    await expect(preview).toHaveCSS("width", "390px");
    await expect(preview.getByRole("heading", { name: "Delivery guide" })).toBeVisible();
    await preview.screenshot({ path: testInfo.outputPath("markdown-mobile.png") });
    await runtime.writeFiles(
        new Map([
            [
                "/workspace/docs/guide.MD",
                { content: markdown.replace("Delivery guide", "Updated guide"), mediaType: "text/plain" },
            ],
        ]),
    );
    await preview.getByRole("button", { name: "Reload file" }).click();
    await expect(preview.getByRole("heading", { name: "Updated guide" })).toBeVisible();
    await preview.getByRole("button", { name: "Related notes" }).click();
    await expect(preview.getByRole("heading", { name: "Related notes" })).toBeVisible();
    await preview.getByRole("button", { name: "Close file preview" }).click();
    await expect(composer).toHaveValue("Please refine the guide");
    await expect(link).toBeFocused();
});
