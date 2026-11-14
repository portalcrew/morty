import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAllByRole, getByRole, queryAllByRole, queryByRole } from "@testing-library/dom";
import type { DetachedWindowAPI } from "happy-dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { openAgentModelPicker, readyComposer, sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

declare global {
    interface Window {
        readonly happyDOM: DetachedWindowAPI;
    }
}

async function waitForConnection(app: TestApp, status: string): Promise<void> {
    await app.waitForView(() => {
        const statuses = app.elementsByTestId(dataTestId.botConnectionStatus);
        expect(statuses.length).toBeGreaterThan(0);
        expect(statuses.every((element) => element.getAttribute("data-connection-status") === status)).toBe(true);
    });
}

test("Given full harness settings, When the user searches and edits them with the keyboard, Then selections are retained in the conversation and focus returns", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        connectAgent: true,
        agent: { harness: "configuration-test", label: "Settings Agent" },
    });
    const trigger = await app.queryElementByTestId(dataTestId.agentConfiguration);
    await app.user.click(trigger);
    await openAgentModelPicker(app);
    const search = getByRole(document.body, "searchbox", { name: "Search models" });
    await app.user.type(search, "unmatched model");
    expect(getByRole(getByRole(document.body, "dialog", { name: "Model options" }), "status").textContent).toBe(
        "No models found.",
    );
    await app.user.keyboard("{Escape}");
    const model = getByRole(document.body, "combobox", { name: "Model" });
    await app.waitForView(() => expect(document.activeElement).toBe(model));
    await app.user.keyboard("{ArrowDown}");
    const keyboardSearch = getByRole(document.body, "searchbox", { name: "Search models" });
    await app.waitForView(() => expect(document.activeElement).toBe(keyboardSearch));
    await app.user.type(keyboardSearch, "large");
    await app.user.keyboard("{ArrowDown}{Enter}");
    await app.waitForView(() => {
        const updatedModel = getByRole(document.body, "combobox", { name: "Model" });
        expect(updatedModel.textContent).toContain("Test Large");
        expect(document.activeElement).toBe(updatedModel);
    });
    for (const { label, value } of [
        { label: "Mode", value: "Plan" },
        { label: "Effort", value: "Low" },
    ]) {
        await app.user.click(getByRole(document.body, "combobox", { name: label }));
        await app.user.click(getByRole(document.body, "option", { name: value }));
    }
    await app.user.click(getByRole(document.body, "switch", { name: "Fast mode" }));
    await app.user.click(getByRole(document.body, "button", { name: "Close Agent configuration" }));
    await app.waitForView(() => expect(document.activeElement).toBe(trigger));
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    await sendPrompt(app, composer, "Keep my configuration");
    await app.queryElementByTestId(
        dataTestId.agentResponse,
        (element) => element.textContent?.includes("Settings Agent: Keep my configuration") === true,
    );
    await app.user.click(getByRole(document.body, "button", { name: "Configure agent" }));
    await app.waitForView(() => {
        expect(getByRole(document.body, "combobox", { name: "Model" }).textContent).toContain("Test Large");
        expect(getByRole(document.body, "combobox", { name: "Mode" }).textContent).toContain("Plan");
        expect(getByRole(document.body, "combobox", { name: "Effort" }).textContent).toContain("Low");
        expect(getByRole(document.body, "switch", { name: "Fast mode" }).getAttribute("aria-checked")).toBe("true");
    });
});

test("Given a paired Bot on desktop, When the user hovers Mode, Then its options expand to the left and clicking keeps them open", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        connectAgent: true,
        agent: { harness: "configuration-test", label: "Settings Agent" },
    });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );

    const trigger = await app.queryElementByTestId(dataTestId.agentConfiguration);
    await app.user.click(trigger);
    const configuration = getByRole(document.body, "dialog", { name: "Agent configuration" });
    const mode = getByRole(configuration, "combobox", { name: "Mode" });
    await app.user.pointer({ target: mode });
    const modeMenu = await app.waitForView(() => getByRole(document.body, "dialog", { name: "Mode options" }));
    expect(modeMenu.getAttribute("data-side")).toBe("right");
    expect(mode.getAttribute("aria-expanded")).toBe("true");

    await app.user.click(mode);
    expect(getByRole(document.body, "dialog", { name: "Mode options" })).toBe(modeMenu);
    await app.user.keyboard("{Escape}");
    await app.waitForView(() => expect(queryByRole(document.body, "dialog", { name: "Mode options" })).toBeNull());
    // Escape closes only the submenu; the panel stays open so the next setting is reachable.
    expect(getByRole(document.body, "dialog", { name: "Agent configuration" })).toBeDefined();

    const model = getByRole(configuration, "combobox", { name: "Model" });
    await app.user.pointer({ target: model });
    await app.waitForView(() => getByRole(document.body, "dialog", { name: "Model options" }));
    await app.user.pointer({ target: mode });
    await app.waitForView(() => {
        expect(queryByRole(document.body, "dialog", { name: "Model options" })).toBeNull();
        expect(getByRole(document.body, "dialog", { name: "Mode options" })).toBeDefined();
    });

    // Moving straight from one row to the next must hand the submenu over in
    // place, like a conventional hover menu, instead of closing and reopening.
    const effort = getByRole(configuration, "combobox", { name: "Effort" });
    for (const [row, name] of [
        [model, "Model options"],
        [effort, "Effort options"],
        [mode, "Mode options"],
    ] as const) {
        await app.user.pointer({ target: row });
        await app.waitForView(() => {
            expect(getByRole(document.body, "dialog", { name })).toBeDefined();
            expect(queryAllByRole(document.body, "dialog", { name: / options$/ })).toHaveLength(1);
        });
    }
});

test("Given a paired Bot on desktop, When the user opens Model, Then its options expand to the left while the configuration panel remains", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );

    const trigger = await app.queryElementByTestId(dataTestId.agentConfiguration);
    await app.user.click(trigger);
    const configuration = getByRole(document.body, "dialog", { name: "Agent configuration" });
    const model = getByRole(configuration, "combobox", { name: "Model" });
    await app.user.click(model);

    const modelMenu = getByRole(document.body, "dialog", { name: "Model options" });
    expect(modelMenu.getAttribute("data-side")).toBe("right");
    expect(getByRole(configuration, "combobox", { name: "Model" })).toBeDefined();
    expect(model.querySelector(".lucide-chevron-right")).not.toBeNull();
    expect(model.querySelector(".lucide-chevron-right")?.classList.contains("text-morty-text-3")).toBe(true);
    expect(model.querySelector(".lucide-chevron-right")?.classList.contains("group-hover:text-foreground")).toBe(true);
    const modelValue = model.querySelector("span.min-w-0.truncate");
    expect(modelValue?.classList.contains("text-copy-secondary")).toBe(true);
    expect(modelValue?.classList.contains("group-hover:text-secondary-foreground")).toBe(true);
    expect(modelValue?.classList.contains("group-active:text-foreground")).toBe(true);
    expect(modelValue?.classList.contains("group-data-[state=open]:text-foreground")).toBe(true);
    const search = getByRole(modelMenu, "searchbox", { name: "Search models" });
    expect(search.classList.contains("h-9")).toBe(true);
    expect(search.classList.contains("focus:border-ring")).toBe(true);
    expect(search.classList.contains("focus:ring-[3px]")).toBe(true);
    // Opening with the pointer keeps the search field idle: no focus ring
    // until the user explicitly clicks into it.
    expect(document.activeElement).not.toBe(search);
    await app.user.click(search);
    expect(document.activeElement).toBe(search);

    await app.user.click(getByRole(modelMenu, "option", { name: "Test Large" }));
    await app.waitForView(() => {
        expect(queryByRole(document.body, "dialog", { name: "Model options" })).toBeNull();
        expect(getByRole(configuration, "combobox", { name: "Model" }).textContent).toContain("Test Large");
        expect(document.activeElement).toBe(getByRole(configuration, "combobox", { name: "Model" }));
    });
});

test("Given full harness settings, When one setting changes, Then only that setting shows loading while the others stay interactive", {
    timeout: 30_000,
}, async () => {
    const configurationCanFinish = Promise.withResolvers<void>();
    const configurationStarted = Promise.withResolvers<void>();
    const app = await createTestApp({
        connectAgent: true,
        agent: {
            beforeConfigurationApplied: async (configId, value) => {
                if (configId === "mode" && value === "plan") {
                    configurationStarted.resolve();
                    await configurationCanFinish.promise;
                }
            },
            harness: "configuration-test",
            label: "Settings Agent",
        },
    });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Start a session");
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Start a session");
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
    });
    await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
    const configuration = getByRole(document.body, "dialog", { name: "Agent configuration" });
    const mode = getByRole(configuration, "combobox", { name: "Mode" });
    const model = getByRole(configuration, "combobox", { name: "Model" });
    const effort = getByRole(configuration, "combobox", { name: "Effort" });

    await app.user.click(mode);
    await app.user.click(getByRole(document.body, "option", { name: "Plan" }));
    await configurationStarted.promise;
    await app.waitForView(() => {
        expect(getByRole(configuration, "combobox", { name: "Mode" }).getAttribute("aria-busy")).toBe("true");
        expect(getByRole(configuration, "combobox", { name: "Mode" }).hasAttribute("disabled")).toBe(true);
        expect(getByRole(configuration, "status", { name: "Loading Mode" })).toBeDefined();
        expect(getByRole(configuration, "combobox", { name: "Model" }).getAttribute("aria-busy")).toBeNull();
        expect(getByRole(configuration, "combobox", { name: "Effort" }).getAttribute("aria-busy")).toBeNull();
        expect(queryAllByRole(configuration, "status", { name: /^Loading / })).toHaveLength(1);
    });

    configurationCanFinish.resolve();
    await app.waitForView(() => {
        expect(getByRole(configuration, "combobox", { name: "Mode" }).textContent).toContain("Plan");
        expect(getByRole(configuration, "combobox", { name: "Mode" }).getAttribute("aria-busy")).toBeNull();
        expect(queryAllByRole(configuration, "status", { name: /^Loading / })).toHaveLength(0);
    });
    expect(model.getAttribute("aria-busy")).toBeNull();
    expect(effort.getAttribute("aria-busy")).toBeNull();
});

test("Given Morty has no paired agent, When the setup page opens, Then it offers the current-origin setup instruction without a data region selector", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp();
    const pairing = await app.queryElementByTestId(dataTestId.pairingInstruction);

    expect(pairing).toBeInstanceOf(HTMLTextAreaElement);
    expect(pairing).toHaveProperty("readOnly", true);
    expect(pairing).toHaveProperty(
        "value",
        `Fetch ${window.location.origin}/doc/setup.md and complete the Morty setup for me. You may install missing prerequisites and pair this computer.`,
    );
    expect(queryByRole(document.body, "combobox", { name: "Data region" })).toBeNull();
    expect(queryByRole(document.body, "button", { name: "Refresh pairing instruction" })).toBeNull();
    const dialog = getByRole(document.body, "dialog", { name: "Connect agent" });
    expect(getByRole(dialog, "button", { name: "Copy setup prompt" })).toBeInstanceOf(HTMLButtonElement);
    expect(dialog.textContent).not.toContain("Step away. Keep your agent working.");
    expect(dialog.textContent).not.toContain("Works with Codex, Claude Code, and Pi.");
    expect(dialog.textContent).not.toContain("Local execution. Remote access you can revoke.");
});

test("Given a paired Bot, When its Computer disconnects, Then the disconnected status is visible", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        prepare: async (application) => {
            const runtime = await application.connectAgent();
            await runtime.disconnect();
        },
    });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "disconnected",
    );
});

test("Given a paired Bot with cached agent settings, When a user filters its models, Then the configuration and Agent reply are visible", {
    timeout: 30_000,
}, async () => {
    const created = await createTestApp({ connectAgent: true });
    const failure = created.agentFailure ?? Promise.reject(new Error("The test Agent was not started."));
    await created.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await created.queryElementByTestId(dataTestId.messageComposer);
    expect(composer).toBeInstanceOf(HTMLTextAreaElement);
    expect(composer).toHaveProperty("disabled", false);
    expect(created.optionalElementByTestId(dataTestId.pairingInstruction)).toBeNull();

    await created.user.click(await created.queryElementByTestId(dataTestId.agentConfiguration));
    await openAgentModelPicker(created);
    const search = await created.queryElementByTestId(dataTestId.modelSearch);
    await created.user.type(search, "large");
    await created.queryElementByTestId(
        dataTestId.sessionConfigValue("test-large"),
        (element) => element.textContent?.includes("Test Large") === true,
    );
    expect(created.optionalElementByTestId(dataTestId.sessionConfigValue("test-small"))).toBeNull();
    await created.user.keyboard("{Escape}{Escape}");

    const prompt = "Confirm the refreshed model settings";
    await sendPrompt(created, composer, prompt);
    await Promise.race([
        Promise.all([
            created.queryElementByTestId(
                dataTestId.userMessage,
                (element) => element.textContent?.includes(prompt) === true,
            ),
            created.waitForView(() => {
                const response = created
                    .elementsByTestId(dataTestId.agentResponse)
                    .find((element) => element.textContent?.includes(`Codex turn 1: ${prompt}`) === true);
                expect(response).toBeDefined();
                return response;
            }),
        ]),
        failure,
    ]);
    await created.waitForView(() => expect(created.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
});

test("Given a paired computer, When a user opens Agent configuration, Then its harnesses appear once and unavailable harnesses are disabled", {
    timeout: 30_000,
}, async () => {
    const created = await createTestApp({ connectAgent: true });
    const failure = created.agentFailure ?? Promise.reject(new Error("The test Agent was not started."));
    await Promise.race([waitForConnection(created, "connected"), failure]);

    await created.user.click(await created.queryElementByTestId(dataTestId.agentConfiguration));
    const configuration = getByRole(document.body, "dialog", { name: "Agent configuration" });

    const harnesses = getByRole(configuration, "radiogroup", { name: "Harness" });
    expect(getAllByRole(harnesses, "radio", { name: "Codex" })).toHaveLength(1);
    expect(getAllByRole(harnesses, "radio", { name: "Pi" })).toHaveLength(1);
    expect(getAllByRole(harnesses, "radio")).toHaveLength(2);
    expect(getByRole(harnesses, "radio", { name: "Pi" }).getAttribute("aria-disabled")).toBe("true");
});

test("Given a Bot has a recent directory from another harness, When its Computer configuration loads, Then the directory remains available", {
    timeout: 30_000,
}, async () => {
    const created = await createTestApp({
        connectAgent: true,
        prepare: (current) =>
            window.localStorage.setItem(
                `morty:recent-cwd:${encodeURIComponent(current.computerId)}`,
                JSON.stringify([{ directory: "saved-directory", directoryLabel: "/saved-by-another-harness" }]),
            ),
    });
    const failure = created.agentFailure ?? Promise.reject(new Error("The test Agent was not started."));

    const menu = await Promise.race([
        (async () => {
            const workingDirectory = await created.queryElementByTestId(dataTestId.workingDirectory);
            await created.user.click(workingDirectory);
            return await created.queryElementByTestId(
                dataTestId.recentWorkingDirectory,
                (element) => element.textContent?.includes("/saved-by-another-harness") === true,
            );
        })(),
        failure,
    ]);

    expect(menu.textContent).toContain("/saved-by-another-harness");
});

test("Given the working directory browser is open, When the user edits the path, Then folder navigation is disabled until the preview settles", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const failure = app.agentFailure ?? Promise.reject(new Error("The test Agent was not started."));

    await Promise.race([
        app.queryElementByTestId(
            dataTestId.botConnectionStatus,
            (element) => element.getAttribute("data-connection-status") === "connected",
        ),
        failure,
    ]);
    await app.user.click(await app.queryElementByTestId(dataTestId.workingDirectory));
    await app.user.click(await app.queryElementByTestId(dataTestId.changeWorkingDirectory));

    const path = await app.queryElementByTestId(dataTestId.workingDirectoryPath);
    const preview = await app.queryElementByTestId(dataTestId.workingDirectoryPreview);
    const navigation = getAllByRole(preview, "button")[0];
    if (!(path instanceof HTMLInputElement) || !(navigation instanceof HTMLButtonElement)) {
        throw new Error("Expected working directory path and folder navigation controls");
    }
    expect(navigation.disabled).toBe(false);

    await app.user.type(path, "/");
    expect(navigation.disabled).toBe(true);

    await Promise.race([
        app.waitForView(() => {
            const settledNavigation = getAllByRole(
                app.elementByTestId(dataTestId.workingDirectoryPreview),
                "button",
            )[0];
            if (!(settledNavigation instanceof HTMLButtonElement)) {
                throw new Error("Expected settled folder navigation controls");
            }
            expect(settledNavigation.disabled).toBe(false);
            return settledNavigation;
        }),
        failure,
    ]);

    await app.user.type(path, "/missing-cwd-preview");
    const failedNavigation = getAllByRole(app.elementByTestId(dataTestId.workingDirectoryPreview), "button")[0];
    if (!(failedNavigation instanceof HTMLButtonElement)) {
        throw new Error("Expected folder navigation controls during failed preview");
    }
    expect(failedNavigation.disabled).toBe(true);

    await Promise.race([
        app.waitForView(() => {
            const failedPreview = app.elementByTestId(dataTestId.workingDirectoryPreview);
            expect(getByRole(failedPreview, "alert")).toBeDefined();
            const settledNavigation = getAllByRole(failedPreview, "button")[0];
            if (!(settledNavigation instanceof HTMLButtonElement)) {
                throw new Error("Expected folder navigation controls after failed preview");
            }
            expect(settledNavigation.disabled).toBe(false);
            return settledNavigation;
        }),
        failure,
    ]);
});

test("Given a project directory whose Agent settings choose another model, When the user starts a conversation there, Then the draft shows and the conversation runs that directory's model", {
    timeout: 60_000,
}, async () => {
    const root = await mkdtemp(join(tmpdir(), "morty-project-settings-"));
    try {
        const project = join(await realpath(root), "project");
        await mkdir(join(project, ".claude"), { recursive: true });
        await writeFile(join(project, ".claude", "settings.json"), JSON.stringify({ model: "test-large" }));
        const app = await createTestApp({
            connectAgent: true,
            agent: { harness: "settings-test", label: "Settings Agent" },
        });
        await app.queryElementByTestId(
            dataTestId.agentConfiguration,
            (element) => element.textContent?.includes("Test Small") === true,
        );

        await app.user.click(app.elementByTestId(dataTestId.workingDirectory));
        await app.user.click(await app.queryElementByTestId(dataTestId.changeWorkingDirectory));
        const path = await app.queryElementByTestId(dataTestId.workingDirectoryPath);
        await app.user.clear(path);
        await app.user.type(path, project);
        await app.user.click(
            await app.queryElementByTestId(
                dataTestId.saveWorkingDirectory,
                (element) => element instanceof HTMLButtonElement && !element.disabled,
            ),
        );
        await app.queryElementByTestId(
            dataTestId.agentConfiguration,
            (element) => element.textContent?.includes("Test Large") === true,
        );

        await sendPrompt(app, app.elementByTestId(dataTestId.messageComposer), "Use the project model");
        await app.waitForView(() =>
            expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
                "Settings Agent: Use the project model",
            ),
        );
        expect(app.elementByTestId(dataTestId.agentConfiguration).textContent).toContain("Test Large");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("Given a conversation whose settings the user left untouched, When the user starts a New Session in a project directory whose Agent settings choose another model, Then the new conversation runs that directory's model", {
    timeout: 90_000,
}, async () => {
    const root = await mkdtemp(join(tmpdir(), "morty-project-settings-"));
    try {
        const project = join(await realpath(root), "project");
        await mkdir(join(project, ".claude"), { recursive: true });
        await writeFile(join(project, ".claude", "settings.json"), JSON.stringify({ model: "test-large" }));
        const app = await createTestApp({
            connectAgent: true,
            agent: { harness: "settings-test", label: "Settings Agent" },
        });
        await app.queryElementByTestId(
            dataTestId.agentConfiguration,
            (element) => element.textContent?.includes("Test Small") === true,
        );
        await sendPrompt(app, app.elementByTestId(dataTestId.messageComposer), "First in default");
        await app.waitForView(() =>
            expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
                "Settings Agent: First in default",
            ),
        );

        await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
        await app.user.click(await app.queryElementByTestId(dataTestId.workingDirectory));
        await app.user.click(await app.queryElementByTestId(dataTestId.changeWorkingDirectory));
        const path = await app.queryElementByTestId(dataTestId.workingDirectoryPath);
        await app.user.clear(path);
        await app.user.type(path, project);
        await app.user.click(
            await app.queryElementByTestId(
                dataTestId.saveWorkingDirectory,
                (element) => element instanceof HTMLButtonElement && !element.disabled,
            ),
        );
        await app.queryElementByTestId(
            dataTestId.workingDirectory,
            (element) => element.textContent?.includes("project") === true,
        );
        await sendPrompt(app, app.elementByTestId(dataTestId.messageComposer), "Use the project model");

        await app.waitForView(() =>
            expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
                "Settings Agent: Use the project model",
            ),
        );
        await app.waitForView(() =>
            expect(app.elementByTestId(dataTestId.agentConfiguration).textContent).toContain("Test Large"),
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("Given a chosen New Session directory the Computer briefly cannot read, When the draft loads in the default directory and the directory returns, Then the next draft starts in the chosen directory again", {
    timeout: 90_000,
}, async () => {
    const root = await mkdtemp(join(tmpdir(), "morty-chosen-directory-"));
    try {
        const project = join(await realpath(root), "chosen-project");
        const away = join(await realpath(root), "moved-away");
        await mkdir(project, { recursive: true });
        const app = await createTestApp({
            connectAgent: true,
            agent: { harness: "settings-test", label: "Settings Agent" },
        });
        await app.queryElementByTestId(
            dataTestId.agentConfiguration,
            (element) => element.textContent?.includes("Test Small") === true,
        );
        await app.user.click(app.elementByTestId(dataTestId.workingDirectory));
        await app.user.click(await app.queryElementByTestId(dataTestId.changeWorkingDirectory));
        const path = await app.queryElementByTestId(dataTestId.workingDirectoryPath);
        await app.user.clear(path);
        await app.user.type(path, project);
        await app.user.click(
            await app.queryElementByTestId(
                dataTestId.saveWorkingDirectory,
                (element) => element instanceof HTMLButtonElement && !element.disabled,
            ),
        );
        await app.queryElementByTestId(
            dataTestId.workingDirectory,
            (element) => element.textContent?.includes("chosen-project") === true,
        );

        await rename(project, away);
        const unavailable = await app.reload();
        await unavailable.queryElementByTestId(
            dataTestId.agentConfiguration,
            (element) => element.textContent?.includes("Test Small") === true,
        );
        expect(unavailable.elementByTestId(dataTestId.workingDirectory).textContent).not.toContain("chosen-project");

        await rename(away, project);
        const restored = await unavailable.reload();
        await restored.queryElementByTestId(
            dataTestId.workingDirectory,
            (element) => element.textContent?.includes("chosen-project") === true,
        );
        await restored.close();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("Given a Bot paired with the Claude harness, When the user opens its settings, Then the Claude brand mark labels the harness field and the trigger", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true, agent: { harness: "claude", label: "Claude Code" } });
    await waitForConnection(app, "connected");

    const triggerMark = await app.queryElementByTestId(
        dataTestId.harnessTriggerMark,
        (element) => element.getAttribute("data-harness-product") === "claude",
    );
    expect(triggerMark.getAttribute("aria-hidden")).toBe("true");
    expect(triggerMark.tagName).toBe("svg");

    await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
    const configuration = getByRole(document.body, "dialog", { name: "Agent configuration" });
    const harness = getByRole(configuration, "radio", { name: "Claude Code", checked: true });
    expect(harness.textContent).toContain("Claude Code");
    const harnessMark = app.elementByTestId(dataTestId.harnessMark, harness);
    expect(harnessMark.getAttribute("data-harness-product")).toBe("claude");
    expect(harnessMark.getAttribute("aria-hidden")).toBe("true");
    expect(harnessMark.tagName === "svg" || harnessMark.querySelector("svg")).toBeTruthy();
});

test("Given a paired Bot on mobile, When the user opens Agent configuration, Then a bottom sheet presents the settings with an explicit close control", {
    timeout: 30_000,
}, async () => {
    const desktopViewport = { height: window.innerHeight, width: window.innerWidth };
    window.happyDOM.setViewport({ height: 844, width: 413 });
    let app: TestApp | null = null;
    try {
        app = await createTestApp({ connectAgent: true });
        await readyComposer(app);

        const navigationButton = getByRole(document.body, "button", { name: "Recent sessions" });
        await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
        const configuration = getByRole(document.body, "dialog", { name: "Agent configuration" });
        await openAgentModelPicker(app);
        expect(await app.queryElementByTestId(dataTestId.modelSearch)).toBeDefined();
        const back = getByRole(configuration, "button", { name: "Back to Agent configuration" });
        await app.user.keyboard("{Escape}");
        const close = getByRole(configuration, "button", { name: "Close Agent configuration" });
        for (const className of ["size-10!", "rounded-full!", "border-[1px]!", "border-white!", "bg-surface-subtle"]) {
            expect(navigationButton.classList.contains(className)).toBe(true);
            expect(back.classList.contains(className)).toBe(true);
            expect(close.classList.contains(className)).toBe(true);
        }
        expect(back.querySelector("svg")?.classList.contains("size-5")).toBe(true);
        expect(close.querySelector("svg")?.classList.contains("size-5")).toBe(true);
        await app.user.click(close);
        expect(queryByRole(document.body, "dialog", { name: "Agent configuration" })).toBeNull();
    } finally {
        if (app !== null) {
            await app.close();
        }
        window.happyDOM.setViewport(desktopViewport);
    }
});

test("Given a paired Bot, When the composer controls are visible, Then the configuration trigger shows its harness mark without repeating the harness or computer name", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );

    const configurationTrigger = await app.queryElementByTestId(dataTestId.agentConfiguration);
    expect(configurationTrigger.textContent).toContain("Test Small");
    expect(configurationTrigger.textContent).not.toContain("Codex");
    expect(configurationTrigger.textContent).not.toContain("Controlled Agent Runtime");
    expect(configurationTrigger.querySelector(".lucide-sliders-horizontal")).toBeNull();
    expect(app.elementByTestId(dataTestId.harnessTriggerMark, configurationTrigger)).toBeDefined();
});

test("Given a Bot paired with an unlisted harness, When the user opens its settings, Then a generic mark labels the harness field without renaming it", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        connectAgent: true,
        agent: { harness: "unlisted-agent", label: "Unlisted Agent" },
    });
    await waitForConnection(app, "connected");

    const triggerMark = await app.queryElementByTestId(
        dataTestId.harnessTriggerMark,
        (element) => element.getAttribute("data-harness-product") === "generic",
    );
    expect(triggerMark.getAttribute("aria-hidden")).toBe("true");

    await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
    const configuration = getByRole(document.body, "dialog", { name: "Agent configuration" });
    const harness = getByRole(configuration, "radio", { name: "Unlisted Agent", checked: true });
    expect(harness.textContent).toContain("Unlisted Agent");
    expect(app.elementByTestId(dataTestId.harnessMark, harness).getAttribute("data-harness-product")).toBe("generic");
    const harnesses = getByRole(configuration, "radiogroup", { name: "Harness" });
    expect(getAllByRole(harnesses, "radio", { name: "Unlisted Agent" })).toHaveLength(1);
    expect(getByRole(harnesses, "radio", { name: "Pi" }).getAttribute("aria-disabled")).toBe("true");
});

test("Given a Bot paired with Pi, When the user opens its settings and sends a prompt, Then Pi and its streamed reply are visible", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true, agent: { harness: "pi", label: "Pi" } });
    await waitForConnection(app, "connected");
    await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
    const configuration = getByRole(document.body, "dialog", { name: "Agent configuration" });
    expect(getByRole(configuration, "radio", { name: "Pi", checked: true }).textContent).toContain("Pi");
    await app.user.keyboard("{Escape}");
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected composer");
    }
    const prompt = "Reply through the Pi integration";
    await sendPrompt(app, composer, prompt);
    await app.waitForView(() => {
        const reply = app
            .elementsByTestId(dataTestId.agentResponse)
            .find((element) => element.textContent?.includes(prompt));
        expect(reply).toBeDefined();
        return reply;
    });
});

test("Given another tab saved a recent directory, When this tab reopens its directory menu and forgets a directory, Then the other tab's directory is listed and remains", {
    timeout: 30_000,
}, async () => {
    const key = (computerId: string) => `morty:recent-cwd:${encodeURIComponent(computerId)}`;
    const here = { directory: "directory-here", directoryLabel: "/project-here" };
    const there = { directory: "directory-there", directoryLabel: "/project-from-another-tab" };
    const app = await createTestApp({
        connectAgent: true,
        prepare: (current) => window.localStorage.setItem(key(current.computerId), JSON.stringify([here])),
    });
    const recent = (label: string) =>
        app.elementsByTestId(dataTestId.recentWorkingDirectory).some((item) => item.textContent?.includes(label));

    await app.user.click(await app.queryElementByTestId(dataTestId.workingDirectory));
    await app.waitForView(() => expect(recent("/project-here")).toBe(true));
    // Another tab of the same Bot saves a directory through the same storage.
    window.localStorage.setItem(key(app.computerId), JSON.stringify([there, here]));
    // Reopening the menu shows it, with no change made in this tab.
    await app.user.keyboard("{Escape}");
    await app.user.click(await app.queryElementByTestId(dataTestId.workingDirectory));
    await app.waitForView(() => expect(recent("/project-from-another-tab")).toBe(true));
    const forget = app
        .elementsByTestId(dataTestId.forgetRecentWorkingDirectory)
        .find((element) => element.getAttribute("aria-label")?.includes("/project-here") === true);
    if (forget === undefined) {
        throw new Error("Expected to forget /project-here");
    }
    await app.user.click(forget);
    await app.user.keyboard("{Escape}");

    await app.user.click(await app.queryElementByTestId(dataTestId.workingDirectory));
    await app.waitForView(() => expect(recent("/project-from-another-tab")).toBe(true));
    expect(recent("/project-here")).toBe(false);
});
