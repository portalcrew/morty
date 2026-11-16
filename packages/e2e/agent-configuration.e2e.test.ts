import { expect, test } from "./infra/test.ts";

test.use({ runtimeAgent: { harness: "configuration-test", name: "Settings Agent" } });

test("Given desktop configuration, When the user opens settings and selects a model, Then the panel fits its content and restores focus", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await runtime.openPairedChat();
    const trigger = page.getByRole("button", { name: "Configure agent" });
    await trigger.click();
    const panel = page.getByRole("dialog", { name: "Agent configuration" });
    const model = page.getByRole("combobox", { name: "Model", exact: true });
    await expect(model).toBeEnabled();
    const bounds = await panel.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds?.height).toBeLessThan(460);
    const fast = page.getByRole("switch", { name: "Fast mode" });
    await expect(fast).toBeVisible();
    await fast.click();
    await expect(fast).toBeChecked();
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("desktop-configuration.png") });
    await model.click();
    const modelOptions = page.getByRole("dialog", { name: "Model options" });
    await expect(modelOptions).toBeVisible();
    const [optionsBounds, modelBounds] = await Promise.all([modelOptions.boundingBox(), model.boundingBox()]);
    expect(optionsBounds?.x).toBeGreaterThanOrEqual((modelBounds?.x ?? 0) + (modelBounds?.width ?? 0));
    await expect(panel).toBeVisible();
    const search = page.getByRole("searchbox", { name: "Search models" });
    await search.click();
    const before = await search.boundingBox();
    await search.fill("large");
    await expect(page.getByRole("option", { name: "Test Small", exact: true })).toBeHidden();
    expect((await search.boundingBox())?.y).toBe(before?.y);
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("model-picker.png") });
    await page.getByRole("option", { name: "Test Large", exact: true }).click();
    await expect(model).toContainText("Test Large");
    await expect(model).toBeFocused();
    await model.click();
    await page.keyboard.press("Escape");
    await expect(modelOptions).toBeHidden();
    await expect(panel).toBeVisible();
    await expect(model).toBeFocused();
    await page.getByRole("combobox", { name: "Mode", exact: true }).click();
    const plan = page.getByRole("dialog", { name: "Mode options" }).getByRole("option", { name: "Plan", exact: true });
    await plan.click();
    await expect(page.getByRole("combobox", { name: "Mode", exact: true })).toContainText("Plan");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(trigger).toContainText("Test Large");
});

test("Given an open setting submenu, When the pointer crosses another row toward it, Then the original submenu stays open", async ({
    runtime,
}) => {
    const { page } = runtime;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await runtime.openPairedChat();
    await page.getByRole("button", { name: "Configure agent" }).click();

    const model = page.getByRole("combobox", { name: "Model", exact: true });
    await model.hover();
    const modelOptions = page.getByRole("dialog", { name: "Model options" });
    await expect(modelOptions).toBeVisible();
    const [modelBounds, optionsBounds] = await Promise.all([model.boundingBox(), modelOptions.boundingBox()]);
    expect(modelBounds).not.toBeNull();
    expect(optionsBounds).not.toBeNull();
    if (modelBounds === null || optionsBounds === null) {
        return;
    }

    await page.mouse.move(modelBounds.x + 20, modelBounds.y + modelBounds.height / 2);
    await page.mouse.move(optionsBounds.x + 8, optionsBounds.y + optionsBounds.height - 16, { steps: 12 });
    await expect(modelOptions).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Effort options" })).toBeHidden();

    const effort = page.getByRole("combobox", { name: "Effort", exact: true });
    await effort.hover();
    await expect(page.getByRole("dialog", { name: "Effort options" })).toBeVisible();
});

test.describe("touch configuration", () => {
    test.use({ contextOptions: { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } } });

    test("Given a phone, When the user rotates and selects settings, Then the sheet and its controls remain inside the viewport", async ({
        runtime,
    }, testInfo) => {
        const { page } = runtime;
        await runtime.openPairedChat();
        const trigger = page.getByRole("button", { name: "Configure agent" });
        await trigger.click();
        const panel = page.getByRole("dialog", { name: "Agent configuration" });
        const model = page.getByRole("combobox", { name: "Model", exact: true });
        await expect(model).toBeEnabled();
        expect((await panel.boundingBox())?.height).toBeLessThan(460);
        await expect(page.getByRole("switch", { name: "Fast mode" })).toBeVisible();
        await page.screenshot({ animations: "disabled", path: testInfo.outputPath("phone-configuration.png") });
        for (const viewport of [
            { width: 320, height: 568 },
            { width: 844, height: 390 },
        ]) {
            await page.setViewportSize(viewport);
            await expect(panel).toBeVisible();
            const bounds = await panel.boundingBox();
            expect(bounds?.x).toBe(0);
            expect(bounds?.width).toBe(viewport.width);
            expect(bounds?.y).toBeGreaterThanOrEqual(16);
            expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(viewport.height);
            await model.click();
            const search = page.getByRole("searchbox", { name: "Search models" });
            await expect(search).not.toBeFocused();
            await search.fill("large");
            await page.getByRole("option", { name: "Test Large", exact: true }).click();
            await expect(model).toContainText("Test Large");
            const fast = page.getByRole("switch", { name: "Fast mode" });
            await fast.scrollIntoViewIfNeeded();
            const fastBounds = await fast.boundingBox();
            expect((fastBounds?.y ?? 0) + (fastBounds?.height ?? 0)).toBeLessThanOrEqual(viewport.height);
            await fast.click();
            await page.screenshot({
                animations: "disabled",
                path: testInfo.outputPath(`configuration-${viewport.width}.png`),
            });
        }
        await page.getByRole("button", { name: "Close Agent configuration" }).click();
        await expect(trigger).toBeFocused();
    });
});
