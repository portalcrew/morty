import { getByRole } from "@testing-library/dom";
import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { readyComposer, sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

function harnessProduct(app: TestApp): string | null {
    return app
        .elementByTestId(dataTestId.harnessTriggerMark, app.elementByTestId(dataTestId.agentConfiguration))
        .getAttribute("data-harness-product");
}

async function waitForComposer(app: TestApp): Promise<void> {
    await readyComposer(app);
}

test("Given the draft agent settings are still loading, When they settle, Then the header stands in a skeleton for the agent mark instead of a spinner", {
    timeout: 30_000,
}, async () => {
    const skeletonSelector = `[data-testid="${dataTestId.harnessMarkSkeleton}"]`;
    const observedSkeletons: Element[] = [];
    const observer = new MutationObserver((records) => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (!(node instanceof Element)) {
                    continue;
                }
                if (node.matches(skeletonSelector)) {
                    observedSkeletons.push(node);
                }
                observedSkeletons.push(...node.querySelectorAll(skeletonSelector));
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    onTestFinished(() => observer.disconnect());

    const app = await createTestApp({ connectAgent: true });
    await waitForComposer(app);
    observer.disconnect();

    expect(observedSkeletons.length).toBeGreaterThan(0);
    const skeleton = observedSkeletons[0];
    const titleMark = skeleton?.closest(`[data-testid="${dataTestId.sessionTitleHarnessMark}"]`) ?? null;
    // The placeholder is a pulsing block that already occupies the glyph's footprint, so settling never shifts the title.
    expect(skeleton?.className).toContain("animate-pulse");
    expect(titleMark).not.toBeNull();
    expect(titleMark?.getAttribute("data-harness-product")).toBeNull();

    // The Computer's first installed Agent is the draft's default; whatever it is, its mark replaces the skeleton.
    await app.waitForView(() => expect(harnessProduct(app)).not.toBeNull());
    expect(app.optionalElementByTestId(dataTestId.harnessMarkSkeleton)).toBeNull();
});

async function waitForHarness(app: TestApp, product: string): Promise<void> {
    await app.waitForView(() => expect(harnessProduct(app)).toBe(product));
}

async function selectHarness(app: TestApp, name: string, product: string): Promise<void> {
    await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
    const configuration = getByRole(document.body, "dialog", { name: "Agent configuration" });
    await app.user.click(getByRole(configuration, "radio", { name }));
    // The harness mark changes optimistically while the old fields remain on screen. Wait until the target mark is
    // visible and the loading status is gone so callers act only after the target settings have actually landed.
    await app.waitForView(() => {
        expect(harnessProduct(app)).toBe(product);
        expect(app.optionalElementByTestId(dataTestId.agentSettingsLoading)).toBeNull();
        expect(getByRole(configuration, "combobox", { name: "Model" })).toBeDefined();
    });
    await app.user.keyboard("{Escape}");
}

async function configureModel(app: TestApp, value: string): Promise<void> {
    await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
    await app.user.click(
        await app.queryElementByTestId(
            dataTestId.agentSetting("model"),
            (element) => element instanceof HTMLButtonElement && !element.disabled,
        ),
    );
    await app.user.click(await app.queryElementByTestId(dataTestId.sessionConfigValue(value)));
    await app.user.keyboard("{Escape}");
}

async function startNewSession(app: TestApp): Promise<void> {
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.chatLanding)).not.toBeNull());
}

test("Given a Pi conversation is active, When the user starts a New Session, Then the draft keeps Pi and its model settings instead of the first connected harness, including after a reload", {
    timeout: 60_000,
}, async () => {
    const app = await createTestApp({
        agents: [
            { harness: "codex", label: "Codex" },
            { harness: "pi", label: "Pi" },
        ],
        connectAgent: true,
    });
    await waitForComposer(app);
    // The Computer lists Codex first, so an unremembered draft starts there.
    await waitForHarness(app, "codex");

    await selectHarness(app, "Pi", "pi");
    await waitForHarness(app, "pi");
    await sendPrompt(app, app.elementByTestId(dataTestId.messageComposer), "Work through Pi");
    await app.waitForView(() =>
        expect(
            app.elementsByTestId(dataTestId.agentResponse).some((element) => element.textContent?.includes("turn 1")),
        ).toBe(true),
    );
    await configureModel(app, "test-large");
    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.agentConfiguration).textContent).toContain("Test Large"),
    );

    await startNewSession(app);
    await waitForHarness(app, "pi");
    await app.waitForView(() => {
        expect(getByRole(document.body, "heading", { name: "New Session" }).textContent).toContain("New Session");
        expect(app.elementByTestId(dataTestId.sessionTitleHarnessMark).getAttribute("data-harness-product")).toBe("pi");
        expect(app.elementByTestId(dataTestId.agentConfiguration).textContent).toContain("Test Large");
    });

    // Choosing another harness for the draft must not override the harness of
    // the conversation the user then opens.
    await selectHarness(app, "Codex", "codex");
    await waitForHarness(app, "codex");
    const piConversation = await app.waitForView(() => {
        const conversation = app.elementsByTestId(dataTestId.managedConversation)[0];
        if (conversation === undefined) {
            throw new Error("Waiting for the Pi conversation in the sidebar");
        }
        return conversation;
    });
    await app.user.click(piConversation);
    await waitForComposer(app);
    await waitForHarness(app, "pi");

    await startNewSession(app);
    await waitForHarness(app, "pi");
    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.agentConfiguration).textContent).toContain("Test Large"),
    );

    const reloaded = await app.reload();
    await waitForComposer(reloaded);
    await reloaded.waitForView(() => expect(reloaded.optionalElementByTestId(dataTestId.chatLanding)).not.toBeNull());
    await reloaded.waitForView(() => {
        expect(harnessProduct(reloaded)).toBe("pi");
        expect(getByRole(document.body, "heading", { name: "New Session" })).toBeDefined();
        expect(reloaded.elementByTestId(dataTestId.sessionTitleHarnessMark).getAttribute("data-harness-product")).toBe(
            "pi",
        );
    });
    await reloaded.waitForView(() =>
        expect(reloaded.elementByTestId(dataTestId.agentConfiguration).textContent).toContain("Test Large"),
    );
});

test("Given a Pi draft, When a Codex switch cannot finish because the Computer goes offline, Then the next draft stays on Pi", {
    timeout: 60_000,
}, async () => {
    const app = await createTestApp({
        agents: [
            { harness: "codex", label: "Codex" },
            { harness: "pi", label: "Pi" },
        ],
        connectAgent: true,
    });
    await waitForComposer(app);
    await waitForHarness(app, "codex");
    await selectHarness(app, "Pi", "pi");
    await waitForHarness(app, "pi");

    await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
    const configuration = getByRole(document.body, "dialog", { name: "Agent configuration" });
    if (app.daemon === null) {
        throw new Error("Expected a connected Computer");
    }
    await app.user.click(getByRole(configuration, "radio", { name: "Codex" }));
    await app.daemon.disconnect();

    // The switch cannot be applied while the Computer is offline. Reloading
    // abandons it, so the next draft must fall back to the last applied
    // harness instead of the one that never loaded.
    const reloaded = await app.reload();
    await app.daemon.reconnect();
    await reloaded.waitForView(() => expect(reloaded.optionalElementByTestId(dataTestId.chatLanding)).not.toBeNull());
    await waitForHarness(reloaded, "pi");
});
