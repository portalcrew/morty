import { dataTestId } from "../web/src/data-testid.ts";
import { expect, test } from "./infra/test.ts";
import type { createTestRuntime } from "./infra/test-runtime.ts";

type E2EPage = Awaited<ReturnType<typeof createTestRuntime>>["page"];

async function clickContinueOnAnotherDevice(page: E2EPage) {
    await page.getByRole("button", { name: "Continue on another device", exact: true }).click();
}

async function clickEndCurrentAccess(page: E2EPage, viewportName: string) {
    if (viewportName === "desktop") {
        await page.getByTestId(dataTestId.userMenu).click();
        await page.getByTestId(dataTestId.endRemoteAccess).click();
        return;
    }
    await page.getByRole("button", { name: "End current access" }).click();
}

for (const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 },
]) {
    test(`Given a working agent on ${viewport.name}, When the user shares and ends the receiving browser's access, Then the scope is clear and the local task continues`, async ({
        runtime,
    }, testInfo) => {
        const { page } = runtime;
        await page.setViewportSize(viewport);
        await runtime.openPairedChat();
        await page.getByRole("textbox", { name: "Message" }).fill("hold after first delta");
        await page.getByRole("button", { name: "Send message" }).click();
        await expect(
            page.getByRole("article", { name: "Agent response" }).filter({ hasText: "Partial reply" }),
        ).toBeVisible();
        if (viewport.name === "mobile") {
            await page.getByRole("button", { name: "Open navigation", exact: true }).click();
            const share = page.getByRole("button", { name: "Continue on another device" });
            await expect(share).toHaveText("Continue on another device");
            await expect(page.getByRole("button", { name: "End current access" })).toBeVisible();
        } else {
            await expect(page.getByTestId(dataTestId.shareIdentity)).toBeVisible();
            await page.getByTestId(dataTestId.userMenu).click();
            await expect(page.getByRole("menuitem", { name: "End current access" })).toBeVisible();
            await page.keyboard.press("Escape");
        }
        await page.screenshot({
            animations: "disabled",
            path: testInfo.outputPath("access-actions.png"),
            fullPage: true,
        });
        await clickContinueOnAnotherDevice(page);

        const sharing = page.getByRole("dialog", { name: "Continue on another device" });
        await expect(sharing.getByRole("alert")).toContainText(
            "Anyone who opens this link can view and control every session on this computer",
        );
        await expect(sharing).toContainText("Works for one device until");
        await expect(sharing).toContainText("That device keeps access until");
        const copyLink = sharing.getByRole("button", { name: "Copy link" });
        const qr = sharing.getByRole("img", { name: "Continue on another device QR code" });
        await expect(copyLink).toBeVisible();
        await expect(qr).toBeVisible();
        await sharing.screenshot({
            animations: "disabled",
            path: testInfo.outputPath("sharing-scope.png"),
            mask: [copyLink, qr],
            maskColor: "#e2e8f0",
        });
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        await copyLink.click();
        await expect(sharing.getByRole("button", { name: "Copied" })).toBeVisible();
        const url = await page.evaluate(() => navigator.clipboard.readText());
        const browser = page.context().browser();
        if (url === "" || browser === null) {
            throw new Error("Sharing needs a copied link and a browser for the receiving device.");
        }
        const receiverContext = await browser.newContext({
            viewport,
            isMobile: viewport.name === "mobile",
            hasTouch: viewport.name === "mobile",
        });
        try {
            const receiver = await receiverContext.newPage();
            await receiver.goto(url);
            if (viewport.name === "desktop") {
                await expect(receiver.getByTestId(dataTestId.userMenu)).toBeVisible();
            } else {
                await receiver.getByRole("button", { name: "Open navigation", exact: true }).click();
                await expect(receiver.getByRole("button", { name: "End current access" })).toBeVisible();
            }
            await clickEndCurrentAccess(receiver, viewport.name);
            const confirmation = receiver.getByRole("dialog", { name: "End current access?" });
            await expect(confirmation).toContainText("This browser loses access to your computer");
            await expect(confirmation).toContainText("links you already shared still work until they expire");
            await expect(confirmation).toContainText("Your local agent and tasks keep running");
            await confirmation.screenshot({
                animations: "disabled",
                path: testInfo.outputPath("end-access-confirmation.png"),
            });
            await confirmation.getByRole("button", { name: "Cancel" }).click();
            await expect(confirmation).toBeHidden();
            await clickEndCurrentAccess(receiver, viewport.name);
            await confirmation.getByRole("button", { name: "End current access", exact: true }).click();

            await expect(receiver.getByRole("status")).toContainText("Current access ended");
            await expect(receiver.getByRole("heading", { name: "Step away. Keep your agent working." })).toBeVisible();
            await receiver.screenshot({
                animations: "disabled",
                path: testInfo.outputPath("access-ended.png"),
                fullPage: true,
            });
            await receiver.reload();
            await expect(receiver.getByRole("heading", { name: "Step away. Keep your agent working." })).toBeVisible();
            await expect(receiver.getByText("Current access ended", { exact: true })).toBeHidden();

            await sharing.getByRole("button", { name: "Close dialog" }).click();
            await runtime.continueReply("hold after first delta", {
                outcome: "complete",
                output: [{ kind: "text", text: "Task continued after access ended." }],
            });
            await expect(
                page
                    .getByRole("article", { name: "Agent response" })
                    .filter({ hasText: "Task continued after access ended." }),
            ).toBeVisible();
        } finally {
            await receiverContext.close();
        }
    });
}

test("Given a recent session on mobile, When the user expands the session list, Then they can select the session and still use sharing actions", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await page.setViewportSize({ width: 390, height: 844 });
    await runtime.openPairedChat();
    await page.getByRole("textbox", { name: "Message" }).fill("Mobile session navigation");
    await page.getByRole("button", { name: "Send message" }).click();
    const response = page
        .getByRole("article", { name: "Agent response" })
        .filter({ hasText: "Mobile session navigation" });
    await expect(response).toBeVisible();
    const sessionUrl = page.url();
    // New Session and Recent sessions sit in the phone's header, outside the navigation drawer.
    await page.getByRole("button", { name: "New Session" }).click();
    await expect(response).toBeHidden();

    const recentSessions = page.getByRole("button", { name: "Recent sessions", exact: true });
    await recentSessions.click();
    const session = page.getByRole("button", { name: "Open Mobile session navigation", exact: true });
    await expect(session).toBeVisible();
    await page.screenshot({
        animations: "disabled",
        path: testInfo.outputPath("mobile-expanded-sessions.png"),
        fullPage: true,
    });
    await expect(page.getByRole("dialog", { name: "Recent sessions", exact: true })).toBeVisible();
    await session.click();
    await expect(page).toHaveURL(sessionUrl);
    await expect(response).toBeVisible();
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await expect(page.getByRole("button", { name: "End current access", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Continue on another device", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Continue on another device", exact: true })).toBeVisible();
});

test("Given one browser opened two setup links in two tabs, When the user ends current access in one tab, Then neither tab nor either link opens Morty any more", async ({
    runtime,
}) => {
    const first = await runtime.followInstructions("/doc/setup.md", "setup-reconnect-session");
    const firstTab = runtime.page;
    await firstTab.goto(first.url);
    await expect(firstTab.getByRole("textbox", { name: "Message" })).toBeEnabled();
    // Running setup again hands off with a new link for the same Computer.
    const second = await runtime.followInstructions("/doc/setup.md", "setup-reconnect-session");
    expect(second.identity.computerId).toBe(first.identity.computerId);
    const secondTab = await firstTab.context().newPage();
    await secondTab.goto(second.url);
    await expect(secondTab.getByRole("textbox", { name: "Message" })).toBeEnabled();

    await clickEndCurrentAccess(secondTab, "desktop");
    await secondTab
        .getByRole("dialog", { name: "End current access?" })
        .getByRole("button", { name: "End current access", exact: true })
        .click();
    await expect(secondTab.getByRole("status")).toContainText("Current access ended");

    // The first tab explains that the browser's access ended, without the user touching it.
    await expect(firstTab.getByRole("status")).toContainText("Current access ended");
    await expect(firstTab.getByRole("textbox", { name: "Message" })).toHaveCount(0);
    for (const link of [first.url, second.url]) {
        await firstTab.goto(link);
        await expect(firstTab.getByRole("heading", { name: "This link is no longer available" })).toBeVisible();
    }
});

test("Given the end-access confirmation is open in one tab, When another tab opens a new link and the user confirms, Then the browser's current access ends in both tabs", async ({
    runtime,
}) => {
    const first = await runtime.followInstructions("/doc/setup.md", "setup-reconnect-session");
    const firstTab = runtime.page;
    await firstTab.goto(first.url);
    await expect(firstTab.getByRole("textbox", { name: "Message" })).toBeEnabled();
    await clickEndCurrentAccess(firstTab, "desktop");
    const confirmation = firstTab.getByRole("dialog", { name: "End current access?" });
    await expect(confirmation).toBeVisible();

    const second = await runtime.followInstructions("/doc/setup.md", "setup-reconnect-session");
    const secondTab = await firstTab.context().newPage();
    await secondTab.goto(second.url);
    await expect(secondTab.getByRole("textbox", { name: "Message" })).toBeEnabled();

    await confirmation.getByRole("button", { name: "End current access", exact: true }).click();

    await expect(firstTab.getByRole("status")).toContainText("Current access ended");
    await expect(secondTab.getByRole("status")).toContainText("Current access ended");
    for (const link of [first.url, second.url]) {
        await secondTab.goto(link);
        await expect(secondTab.getByRole("heading", { name: "This link is no longer available" })).toBeVisible();
    }
});

test("Given a browser without Morty access opens two setup links in two tabs at once, When the user ends current access, Then neither link opens Morty any more", async ({
    runtime,
}) => {
    const first = await runtime.followInstructions("/doc/setup.md", "setup-reconnect-session");
    const second = await runtime.followInstructions("/doc/setup.md", "setup-reconnect-session");
    const firstTab = runtime.page;
    const secondTab = await firstTab.context().newPage();

    await Promise.all([firstTab.goto(first.url), secondTab.goto(second.url)]);
    await expect(firstTab.getByRole("textbox", { name: "Message" })).toBeEnabled();
    await expect(secondTab.getByRole("textbox", { name: "Message" })).toBeEnabled();

    await clickEndCurrentAccess(secondTab, "desktop");
    await secondTab
        .getByRole("dialog", { name: "End current access?" })
        .getByRole("button", { name: "End current access", exact: true })
        .click();
    await expect(secondTab.getByRole("status")).toContainText("Current access ended");

    await expect(firstTab.getByRole("status")).toContainText("Current access ended");
    for (const link of [first.url, second.url]) {
        await secondTab.goto(link);
        await expect(secondTab.getByRole("heading", { name: "This link is no longer available" })).toBeVisible();
    }
});
