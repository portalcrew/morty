import {
    fireEvent,
    getAllByLabelText,
    getAllByRole,
    getAllByText,
    getByRole,
    getByText,
    queryByLabelText,
    queryByRole,
    queryByText,
} from "@testing-library/dom";
import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { renderRegisteredTool } from "../src/components/chat/tools/tool-renderer-registry.tsx";
import { dataTestId } from "../src/data-testid.ts";
import { expandProcessSections, readyComposer, sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given the agent references external content, When the user reads the response, Then Chat loads and renders the referenced file", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, "show external content");
    await expandProcessSections(app);
    const activity = await app.waitForView(() => getByRole(document.body, "group", { name: "Tool: External content" }));
    await app.user.click(getByRole(activity, "button", { name: "External content Tool succeeded" }));
    await app.waitForView(() => {
        const activity = getByRole(document.body, "group", { name: "Tool: External content" });
        const image = activity.querySelector("img");
        if (image === null) {
            throw new Error("The external content image has not rendered");
        }
        if (!(image.src.startsWith("blob:") || image.src.includes("data:"))) {
            throw new Error(`The external content image did not resolve to a preview source: ${image.src}`);
        }
        expect(activity.textContent).not.toContain("Loading content");
        expect(activity.textContent).not.toContain("Content could not be loaded");
    });
});

test("Given the user selected an option and entered a custom response, When they reopen the completed ask tool, Then Chat shows both answers", () => {
    render(
        renderRegisteredTool({
            content: [],
            id: "ask-user-question",
            input: JSON.stringify({
                questions: [
                    {
                        header: "Delivery",
                        multiSelect: false,
                        options: [
                            { description: "Ship the change now.", label: "Ship now" },
                            { description: "Wait for another review.", label: "Wait" },
                        ],
                        question: "When should this ship?",
                    },
                    {
                        header: "Notes",
                        multiSelect: false,
                        options: [{ description: "Enter a different response.", label: "Other" }],
                        question: "Anything else to record?",
                    },
                ],
            }),
            kind: "tool",
            name: "AskUserQuestion",
            output: `Your questions have been answered: "When should this ship?"="Ship now", "Anything else to record?"="Use the customer's \\"exact\\" wording". You can now continue with these answers in mind.`,
            state: { kind: "succeeded" },
            title: "Asking for your input",
        }),
    );

    const askTool = getByRole(document.body, "group", { name: "Questions: Asking for your input" });
    const disclosure = getByRole(askTool, "button", { name: "Asking for your input Tool succeeded" });
    fireEvent.click(disclosure);

    expect(getAllByText(askTool, "Ship now", { exact: true })).toHaveLength(2);
    expect(getByText(askTool, `Use the customer's "exact" wording`, { exact: true })).toBeDefined();
    expect(getAllByText(askTool, "Your answer", { exact: true })).toHaveLength(2);
});

test("Given the agent sends separate adjacent messages, When the user reads the response, Then each message starts a new paragraph", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, "separate response paragraphs");
    await app.waitForView(() => {
        const responses = app.elementsByTestId(dataTestId.agentResponse);
        const paragraphs = [
            "Auto-merge is armed on the rebased head.",
            "Policy, title, and Worker-config checks are green.",
            "Static checks are green now; only the test job remains.",
        ];
        expect(responses).toHaveLength(paragraphs.length);
        for (const [index, response] of responses.entries()) {
            expect(getByText(response, paragraphs[index] ?? "", { exact: true })).toBeDefined();
        }
    });
});

test("Given a Markdown horizontal rule, When the response is rendered, Then its divider uses a half-pixel border", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a controlled Agent Runtime");
    }
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, "hold after first delta");
    await app.waitForView(() => expect(document.body.textContent).toContain("Partial reply"));
    await daemon.continueReply("hold after first delta", {
        outcome: "complete",
        output: [{ kind: "text", text: "\n\nAbove\n\n---\n\nBelow" }],
    });
    const rule = await app.waitForView(() => {
        const element = document.querySelector('[data-streamdown="horizontal-rule"]');
        if (!(element instanceof HTMLElement)) {
            throw new Error("Expected the Markdown horizontal rule");
        }
        return element;
    });
    expect(rule.closest(".agent-markdown")?.className).toContain("[&_hr]:border-t-[0.5px]");
});

test("Given Markdown table and fenced code, When the response is rendered and the user operates the table actions, Then the download menu offers CSV and Markdown and the table opens in fullscreen", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a controlled Agent Runtime");
    }
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, "hold after first delta");
    await app.waitForView(() => expect(document.body.textContent).toContain("Partial reply"));
    await daemon.continueReply("hold after first delta", {
        outcome: "complete",
        output: [
            {
                kind: "text",
                text: "\n\n| Syntax | Output |\n| --- | --- |\n| `code` | code |\n\n```text\n+------+\n| HTML |\n+------+\n```",
            },
        ],
    });
    await app.waitForView(() => {
        expect(document.querySelector('[data-streamdown="code-block-body"]')?.textContent).toContain("HTML");
    });
    const wrapper = await app.waitForView(() => {
        const tableWrapper = document.querySelector('[data-streamdown="table-wrapper"]');
        if (!(tableWrapper instanceof HTMLElement)) {
            throw new Error("The Markdown table has not rendered");
        }
        return tableWrapper;
    });
    expect(getByRole(wrapper, "table").textContent).toContain("Syntax");
    expect(getByRole(wrapper, "table").textContent).toContain("Output");

    // Choosing a format runs the real download path; the menu closes only on success.
    await app.user.click(getByRole(wrapper, "button", { name: "Download table" }));
    await app.waitForView(() => {
        getByRole(wrapper, "button", { name: "CSV" });
        getByRole(wrapper, "button", { name: "Markdown" });
    });
    await app.user.click(getByRole(wrapper, "button", { name: "CSV" }));
    await app.waitForView(() => {
        expect(queryByRole(wrapper, "button", { name: "CSV" })).toBeNull();
    });

    await app.user.click(getByRole(wrapper, "button", { name: "View fullscreen" }));
    const dialog = await app.waitForView(() => getByRole(document.body, "dialog", { name: "View fullscreen" }));
    expect(getByRole(dialog, "table").textContent).toContain("Syntax");
    await app.user.keyboard("{Escape}");
    await app.waitForView(() => {
        expect(queryByRole(document.body, "dialog", { name: "View fullscreen" })).toBeNull();
    });
    // Hover reveal, the chip and header tint, and the absent scroll cap are CSS cascade and
    // layout facts that happy-dom does not compute; browser evidence covers them instead.
});

test("Given an open code block, When the agent appends code, Then the visible block updates before the response completes", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a controlled Agent Runtime");
    }
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, "hold after first delta");
    await app.waitForView(() => expect(document.body.textContent).toContain("Partial reply"));
    await daemon.continueReply("hold after first delta", {
        outcome: "hold",
        output: [{ kind: "text", text: "\n\n```typescript\n" }],
    });
    await app.waitForView(() => expect(queryByRole(document.body, "button", { name: "Copy code" })).toBeNull());

    await daemon.continueReply("hold after first delta", {
        outcome: "hold",
        output: [{ kind: "text", text: 'const answer = 42;\nconst label = "complete";\n' }],
    });

    await app.waitForView(() => expect(document.body.textContent).toContain("const answer = 42;"));
    expect(document.body.textContent).toContain('const label = "complete";');
    expect(getByRole(document.body, "button", { name: "Stop agent output" })).toBeDefined();

    await daemon.continueReply("hold after first delta", {
        outcome: "complete",
        output: [{ kind: "text", text: "```\n" }],
    });
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    expect(document.body.textContent).toContain("const answer = 42;");
    expect(document.body.textContent).toContain('const label = "complete";');
});

test("Given an open code block without a language, When the agent appends code, Then the visible block updates before the response completes", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a controlled Agent Runtime");
    }
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, "hold after first delta");
    await app.waitForView(() => expect(document.body.textContent).toContain("Partial reply"));
    await daemon.continueReply("hold after first delta", {
        outcome: "hold",
        output: [{ kind: "text", text: "\n\n```\nThe setup prompt goes here.\n```\n\n" }],
    });
    await app.waitForView(() => expect(document.body.textContent).toContain("The setup prompt goes here."));

    await daemon.continueReply("hold after first delta", {
        outcome: "hold",
        output: [{ kind: "text", text: "```\nDo not install" }],
    });
    await daemon.continueReply("hold after first delta", {
        outcome: "hold",
        output: [{ kind: "text", text: " it yourself.\nTell your agent to.\n" }],
    });

    await app.waitForView(() => expect(document.body.textContent).toContain("Do not install it yourself."));
    expect(document.body.textContent).toContain("Tell your agent to.");

    await daemon.continueReply("hold after first delta", {
        outcome: "complete",
        output: [{ kind: "text", text: "```\n" }],
    });
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    expect(document.body.textContent).toContain("Do not install it yourself.");
    expect(document.body.textContent).toContain("Tell your agent to.");
});

test("Given the agent sends separate reasoning messages, When the user reads the intermediate steps, Then they form paragraphs in one thinking block", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, "separate reasoning paragraphs");
    await expandProcessSections(app);
    const thinking = await app.queryElementByTestId(dataTestId.agentReasoning);
    await app.user.click(getByText(thinking, "Show Thinking"));
    await app.waitForView(() => {
        expect(thinking.textContent).toContain("**Inspecting** the reported behavior.\n- keep this literal");
        expect(thinking.textContent).toContain("`Checking` the message boundaries.");
    });
    expect(thinking.querySelector("strong")).toBeNull();
    expect(thinking.querySelector("code")).toBeNull();

    await readyComposer(app);
    // A reasoning-only segment has no completion state of its own: once the
    // turn finishes, its summary must stop shimmering.
    expect(document.body.querySelector(".animate-loading-text-shimmer")).toBeNull();
    app.remount();
    await expandProcessSections(app);
    expect(document.body.querySelector(".animate-loading-text-shimmer")).toBeNull();
    const restoredThinking = await app.queryElementByTestId(dataTestId.agentReasoning);
    await app.user.click(getByText(restoredThinking, "Show Thinking"));
    await app.waitForView(() => {
        expect(restoredThinking.textContent).toContain("**Inspecting** the reported behavior.\n- keep this literal");
        expect(restoredThinking.textContent).toContain("`Checking` the message boundaries.");
    });
    expect(restoredThinking.querySelector("strong")).toBeNull();
    expect(restoredThinking.querySelector("code")).toBeNull();
});

test("Given reasoning is still streaming, When the user expands it and then starts answering, Then the explicit expansion survives the end of reasoning", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a controlled Agent Runtime");
    }
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    const prompt = "hold reasoning only";
    await sendPrompt(app, composer, prompt);
    await expandProcessSections(app);

    const thinking = await app.waitForView(() => {
        const disclosure = app.optionalElementByTestId(dataTestId.agentReasoning);
        if (disclosure === null) {
            throw new Error("Expected active reasoning");
        }
        if (!(disclosure instanceof HTMLDetailsElement) || !disclosure.open) {
            throw new Error("Expected active reasoning to open by default");
        }
        return disclosure;
    });
    await app.user.click(getByText(thinking, "Show Thinking"));
    await app.waitForView(() => expect(thinking.open).toBe(false));
    await app.user.click(getByText(thinking, "Show Thinking"));
    await app.waitForView(() => {
        expect(thinking.open).toBe(true);
        expect(thinking.textContent).toContain("Inspecting the workspace while holding.");
    });

    await daemon.continueReply(prompt, {
        outcome: "complete",
        output: [{ kind: "text", text: "Final answer after reasoning." }],
    });

    await app.waitForView(() => {
        expect(document.body.textContent).toContain("Final answer after reasoning.");
        expect(thinking.open).toBe(true);
        expect(thinking.textContent).toContain("Inspecting the workspace while holding.");
    });
});

test("Given reasoning exceeds 16K characters, When the user opens the intermediate steps, Then Chat shows the retained tail and a truncation notice", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, "long reasoning");
    await expandProcessSections(app);
    const thinking = await app.queryElementByTestId(dataTestId.agentReasoning);
    await app.user.click(getByText(thinking, "Show Thinking"));
    await app.waitForView(() => {
        expect(thinking.textContent).toContain("Earlier reasoning was truncated to the most recent 16K characters.");
        expect(thinking.textContent).toContain("REASONING END RETAINED");
    });
    expect(thinking.textContent).not.toContain("REASONING START OMITTED");
    expect(thinking.querySelector("pre")?.textContent?.length).toBeLessThanOrEqual(16_384);
});

test("Given the agent sends many session events, When the response completes, Then every event type remains usable without mounting collapsed reasoning", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, "many session events");
    await app.user.click(await app.waitForView(() => getByRole(document.body, "button", { name: "20 steps" })));
    const thinking = await app.queryElementByTestId(dataTestId.agentReasoning);
    if (!(thinking instanceof HTMLDetailsElement)) {
        throw new Error("Expected reasoning to use a disclosure");
    }
    await app.waitForView(() => {
        expect(thinking.open).toBe(false);
        expect(document.body.textContent).toContain("Inspect item 19");
        expect(document.body.textContent).toContain("Answer part 019.");
    });
    expect(document.body.textContent).not.toContain("Reasoning step 000.");
    expect(document.body.textContent).not.toContain("Reasoning step 039.");

    await app.user.click(getByText(thinking, "Show Thinking"));
    await app.waitForView(() => {
        expect(document.body.textContent).toContain("Reasoning step 000.");
        expect(document.body.textContent).toContain("Reasoning step 039.");
    });
});

test("Given a file tool reports a rich diff, When the user opens it, Then Chat presents it as an edit without raw protocol payloads", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, "show generic file edit");
    await expandProcessSections(app);

    const edit = await app.waitForView(() =>
        getByRole(document.body, "group", { name: "Edit: Write /workspace/style.css" }),
    );
    await app.user.click(getByRole(edit, "button", { name: "Write /workspace/style.css Tool succeeded" }));

    expect(edit.textContent).toContain("body { color: green; }");
    expect(edit.textContent).not.toContain("File created successfully");
    expect(queryByText(edit, "Request")).toBeNull();
    expect(queryByText(edit, "Response")).toBeNull();
});

test("Given Pi reports write and edit tool results, When the user opens them, Then Chat presents their content without protocol metadata", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, "show pi file tools");
    await expandProcessSections(app);

    const write = await app.waitForView(() => getByRole(document.body, "group", { name: "Edit: write" }));
    const edit = getByRole(document.body, "group", { name: "Edit: edit" });
    expect(write.textContent).not.toContain("toolResult");
    expect(edit.textContent).not.toContain("toolResult");

    await app.user.click(getByRole(write, "button", { name: "write Tool succeeded" }));
    await app.user.click(getByRole(edit, "button", { name: "edit Tool succeeded" }));

    expect(write.textContent).toContain("Successfully wrote to /workspace/package.json");
    expect(edit.textContent).toContain("const status = 'after';");
    expect(write.textContent).not.toContain("toolCallId");
    expect(edit.textContent).not.toContain("firstChangedLine");
    expect(queryByText(write, "Response")).toBeNull();
    expect(queryByText(edit, "Response")).toBeNull();
});

test("Given a changed-file summary repeats the rich diff path, When the user opens the edit, Then Chat omits the duplicate path row", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, "change one file with a rich diff summary");
    await expandProcessSections(app);

    const edit = await app.waitForView(() => getByRole(document.body, "group", { name: "Edit: /workspace/app.js" }));
    await app.user.click(getByRole(edit, "button", { name: "/workspace/app.js Tool succeeded" }));
    expect(queryByRole(edit, "list", { name: "Changed files" })).toBeNull();
    expect(getAllByText(edit, "/workspace/app.js", { exact: true })).toHaveLength(2);
});

test("Given a file-change tool repeats its rich diff in raw output, When the user opens it, Then Chat shows the edit once", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, "change one file with duplicate diffs");
    await expandProcessSections(app);

    const edit = await app.waitForView(() =>
        getByRole(document.body, "group", {
            name: "Edit: /workspace/app.js",
        }),
    );
    await app.user.click(getByRole(edit, "button", { name: "/workspace/app.js Tool succeeded" }));
    expect(getAllByText(edit, "/workspace/app.js", { exact: true })).toHaveLength(2);
});

test("Given a browser tool reports its tool-result schema, When the user opens it, Then Chat presents the browser output without protocol metadata", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, "inspect browser surfaces");
    await expandProcessSections(app);

    const browserTools = await app.waitForView(() => {
        const tools = getAllByRole(document.body, "group", { name: "Browser: cua_repl/js" });
        expect(tools).toHaveLength(2);
        return tools;
    });
    const [timedOutTool, successfulTool] = browserTools;
    if (timedOutTool === undefined || successfulTool === undefined) {
        throw new Error("Expected two browser tools");
    }
    expect(timedOutTool.textContent).not.toContain("js execution timed out; kernel reset, rerun your request");
    expect(successfulTool.textContent).not.toContain("null");
    await app.user.click(getByRole(timedOutTool, "button"));
    await app.user.click(getByRole(successfulTool, "button"));
    expect(timedOutTool.textContent).toContain("js execution timed out; kernel reset, rerun your request");
    expect(timedOutTool.textContent).not.toContain("structuredContent");
    expect(timedOutTool.textContent).not.toContain("codex/toolSurface");
    expect(queryByText(timedOutTool, "Request")).toBeNull();
    expect(queryByText(timedOutTool, "Response")).toBeNull();
    expect(successfulTool.textContent).not.toContain("null");
});

test("Given a shell tool completes, When the user views the conversation, Then the tool stays collapsed", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, "run a quiet shell command");
    await expandProcessSections(app);

    const shellTool = await app.waitForView(() =>
        getByRole(document.body, "group", { name: 'Shell command: /bin/zsh -lc "true"' }),
    );
    expect(getByRole(shellTool, "button").getAttribute("aria-expanded")).toBe("false");
    expect(shellTool.textContent).not.toContain('{"exitCode":0,"output":""}');
    expect(queryByText(shellTool, "Response")).toBeNull();
});

test("Given a response links to a TypeScript file, When the user opens it, Then numbered and highlighted source appears beside the conversation", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, "show source file");
    await app.queryElementByTestId(dataTestId.localFileLink);
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    await app.user.click(await app.queryElementByTestId(dataTestId.localFileLink));
    const preview = await app.queryElementByTestId(dataTestId.filePreview);
    const content = await app.queryElementByTestId(dataTestId.filePreviewContent);
    const lineNumbers = app.elementByTestId(dataTestId.filePreviewLineNumbers, content);
    expect(preview.parentElement?.querySelector('[role="log"][aria-label="Messages"]')).not.toBeNull();
    expect(content.textContent).toContain("export function FileExplorer");
    expect(Array.from(lineNumbers.querySelectorAll("[data-line-number]"), (line) => line.textContent)).toEqual(
        Array.from({ length: 53 }, (_, index) => (index + 1).toString()),
    );
    await app.waitForView(() => expect(content.querySelector('code span[style*="--sdm-c"]')).not.toBeNull());
});

test("Given shell output contains ANSI styles, When the user opens it, Then Chat presents terminal colors and emphasis without escape sequences", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, "run a colorful shell command");
    await expandProcessSections(app);

    const shellTool = await app.waitForView(() =>
        getByRole(document.body, "group", { name: 'Shell command: /bin/zsh -lc "pnpm test"' }),
    );
    await app.user.click(getByText(shellTool, '/bin/zsh -lc "pnpm test"'));
    const output = app.elementByTestId(dataTestId.ansiShellOutput, shellTool);
    expect(output.textContent).toBe("failed\npassed");
    expect(output.textContent).not.toContain("\u001B");
    const failed = Array.from(output.querySelectorAll("span")).find((element) => element.textContent === "failed");
    const passed = Array.from(output.querySelectorAll("span")).find((element) => element.textContent === "passed");
    expect(failed?.style.color).not.toBe("");
    expect(passed?.style.color).not.toBe("");
    expect(passed?.style.fontWeight).toBe("bold");
});

test("Given tool results exceed 32 KiB, When the user opens them, Then Chat renders bounded plain-text previews", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, "show huge tool outputs");
    await expandProcessSections(app);

    const genericTool = await app.waitForView(() =>
        getByRole(document.body, "group", { name: "Tool: Huge diagnostic" }),
    );
    const shellTool = await app.waitForView(() =>
        getByRole(document.body, "group", {
            name: 'Shell command: /bin/zsh -lc "huge-output"',
        }),
    );
    await app.user.click(getByRole(genericTool, "button"));
    await app.user.click(getByRole(shellTool, "button"));

    for (const tool of [genericTool, shellTool]) {
        expect(tool.textContent).toContain("BEGIN_TOOL_OUTPUT");
        expect(tool.textContent).toContain("END_TOOL_OUTPUT");
        expect(tool.textContent).toContain("characters omitted");
        expect(tool.textContent).not.toContain("MIDDLE_SHOULD_NOT_RENDER");
        expect(getByRole(tool, "button", { name: "Load more output" })).toBeDefined();
    }
    expect(shellTool.querySelector(`[data-testid="${dataTestId.ansiShellOutput}"]`)).toBeNull();
    expect(queryByText(shellTool, "Request")).toBeNull();
    expect(queryByText(shellTool, "Response")).toBeNull();
    await app.user.click(getByRole(genericTool, "button", { name: "Load more output" }));
    expect(genericTool.textContent).toContain("MIDDLE_SHOULD_NOT_RENDER");
    expect(queryByText(genericTool, "Load more output")).toBeNull();
});

test("Given the daemon emits reasoning, a tool, and text, When the user observes and stops an unfinished turn, Then partial content is visible before completion and survives remount", {
    timeout: 30_000,
}, async () => {
    const prompt = "hold with rich content";
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, prompt);
    const processSummary = await app.waitForView(() =>
        getByRole(document.body, "button", { name: "1 step", expanded: false }),
    );
    expect(getByText(document.body, "Partial rich reply")).toBeDefined();
    expect(processSummary.querySelector(".animate-loading-text-shimmer")).toBeNull();
    expect(queryByText(document.body, "Inspecting the workspace")).toBeNull();
    expect(queryByLabelText(document.body, "Tool: Read package metadata")).toBeNull();

    await app.user.click(processSummary);
    const thinking = await app.queryElementByTestId(dataTestId.agentReasoning);
    if (!(thinking instanceof HTMLDetailsElement)) {
        throw new Error("Expected reasoning to use a disclosure");
    }
    await app.waitForView(() => expect(thinking.textContent).toContain("Show Thinking"));
    expect(thinking.open).toBe(false);
    expect(thinking.querySelector(".animate-loading-text-shimmer")).toBeNull();
    await app.user.click(getByText(thinking, "Show Thinking"));
    await app.waitForView(() => expect(thinking.textContent).toContain("Inspecting the workspace"));
    expect(thinking.open).toBe(true);
    await app.waitForView(() => expect(document.body.textContent).toContain("Read package metadata"));
    const genericTool = await app.queryElementByTestId(dataTestId.agentToolCall);
    expect(getByRole(genericTool, "button").getAttribute("aria-expanded")).toBe("false");
    expect(genericTool.textContent).not.toContain("Package metadata response");
    expect(queryByText(document.body, "Inspecting the workspace")).not.toBeNull();
    await app.queryElementByTestId(dataTestId.sessionStatus);
    await app.user.click(
        await app.queryElementByTestId(
            dataTestId.sendMessage,
            (element) => element.getAttribute("aria-label") === "Stop agent output",
        ),
    );
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    app.remount();
    const restoredProcessSummary = await app.waitForView(() =>
        getByRole(document.body, "button", { name: "1 step", expanded: false }),
    );
    await app.user.click(restoredProcessSummary);
    const restoredThinking = await app.queryElementByTestId(dataTestId.agentReasoning);
    if (!(restoredThinking instanceof HTMLDetailsElement)) {
        throw new Error("Expected restored reasoning to use a disclosure");
    }
    await app.waitForView(() => expect(restoredThinking.open).toBe(false));
    await app.user.click(getByText(restoredThinking, "Show Thinking"));
    await app.waitForView(() => {
        const restored = app
            .elementsByTestId(dataTestId.agentResponse)
            .some((element) => element.textContent?.includes("Partial rich reply") === true);
        if (!restored) {
            throw new Error(`The restored response is unavailable: ${document.body.textContent}`);
        }
    });
    await app.waitForView(() => expect(document.body.textContent).toContain("Read package metadata"));
});

test("Given two process segments are separated by visible text, When the later segment completed but the turn is still open, Then neither segment falsely shimmers", {
    timeout: 30_000,
}, async () => {
    const prompt = "hold with rich content";
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a controlled Agent Runtime");
    }
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, prompt);
    const firstSummary = await app.waitForView(() =>
        getByRole(document.body, "button", { name: "1 step", expanded: false }),
    );
    await app.waitForView(() => expect(getByText(document.body, "Partial rich reply")).toBeDefined());
    expect(firstSummary.querySelector(".animate-loading-text-shimmer")).toBeNull();

    await daemon.continueReply(prompt, {
        outcome: "hold",
        output: [
            {
                activityType: "tool",
                content: [],
                kind: "activity",
                output: "Follow-up verified.",
                title: "Follow-up verification",
            },
        ],
    });
    const summaries = await app.waitForView(() => {
        const buttons = getAllByRole(document.body, "button", { name: "1 step", expanded: false });
        expect(buttons).toHaveLength(2);
        return buttons;
    });
    expect(summaries[0]?.querySelector(".animate-loading-text-shimmer")).toBeNull();
    expect(summaries[1]?.querySelector(".animate-loading-text-shimmer")).toBeNull();

    await daemon.continueReply(prompt, {
        outcome: "complete",
        output: [{ kind: "text", text: "Follow-up complete." }],
    });
    await app.waitForView(() => {
        expect(getByText(document.body, "Follow-up complete.")).toBeDefined();
        const settled = getAllByRole(document.body, "button", { name: "1 step", expanded: false });
        expect(settled).toHaveLength(2);
        for (const summary of settled) {
            expect(summary.querySelector(".animate-loading-text-shimmer")).toBeNull();
        }
    });
});

test("Given an expanded process segment whose tool is still generating, When the user reads it, Then only the segment summary shimmers", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        connectAgent: true,
        agent: { harness: "tool-lifecycle-test", label: "Tool Lifecycle Agent" },
    });
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, "hold unfinished tools");
    const summary = await app.waitForView(() => {
        const button = getByRole(document.body, "button", { name: "4 steps", expanded: false });
        expect(button.querySelector(".animate-loading-text-shimmer")).not.toBeNull();
        return button;
    });
    await app.user.click(summary);
    await app.waitForView(() => {
        const contentId = summary.getAttribute("aria-controls");
        const content = contentId === null ? null : document.getElementById(contentId);
        expect(content).not.toBeNull();
        if (content !== null) {
            expect(content.getBoundingClientRect().top - summary.getBoundingClientRect().bottom).toBe(0);
            expect(content.querySelector(".animate-loading-text-shimmer")).toBeNull();
        }
    });
    expect(app.elementsByTestId(dataTestId.agentToolCall)).toHaveLength(4);
    expect(getAllByLabelText(document.body, "Tool running")).toHaveLength(2);
});

test("Given an Agent response references a local image, When the user reads it and reopens the conversation, Then the image is fetched through Computer and remains visible without base64 text", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, "show generated picture");
    const image = await app.waitForView(() => getByRole(document.body, "img", { name: "Generated picture" }));
    expect(image.getAttribute("src")).toMatch(/^blob:/u);
    expect(getByRole(document.body, "log", { name: "Messages" }).textContent).not.toContain("iVBORw0KGgo");
    app.remount();
    const restored = await app.waitForView(() => getByRole(document.body, "img", { name: "Generated picture" }));
    expect(restored.getAttribute("src")).toMatch(/^blob:/u);
});

test("Given Codex generates an image, When the user opens the tool, Then Chat shows the image without raw protocol fields", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, "generate an image");
    await expandProcessSections(app);

    const imageTool = await app.waitForView(() => getByRole(document.body, "group", { name: "Tool: Generate image" }));
    const disclosure = getByRole(imageTool, "button", { name: "Generate image Tool succeeded" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    await app.user.click(disclosure);
    const image = await app.waitForView(() => getByRole(imageTool, "img", { name: "Image" }));
    expect(image.getAttribute("src")).toMatch(/^blob:/u);
    expect(imageTool.textContent).not.toContain("Request");
    expect(imageTool.textContent).not.toContain("Response");
    expect(imageTool.textContent).not.toContain("null");
    expect(imageTool.textContent).not.toContain("iVBORw0KGgo");
});

test("Given Codex views an image, When the user opens the tool, Then Chat shows the image without its raw path", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, "view an image");
    await expandProcessSections(app);

    const imageTool = await app.waitForView(() => getByRole(document.body, "group", { name: "Tool: View image" }));
    await app.user.click(getByRole(imageTool, "button", { name: "View image Tool succeeded" }));
    expect(await app.waitForView(() => getByRole(imageTool, "img", { name: "Image" }))).toBeDefined();
    expect(imageTool.textContent).not.toContain("Request");
    expect(imageTool.textContent).not.toContain("Response");
    expect(imageTool.textContent).not.toContain("image/png");
});
