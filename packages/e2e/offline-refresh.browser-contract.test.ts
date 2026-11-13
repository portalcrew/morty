import { conversationLoaded, expect, test } from "./infra/test.ts";

test.use({ browserName: "webkit" });
test.setTimeout(120_000);

for (const layout of ["desktop", "mobile"] as const) {
    test.describe(layout, () => {
        test.use({
            contextOptions:
                layout === "mobile"
                    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
                    : { viewport: { width: 1280, height: 800 } },
        });

        test("Given a named session and an unsent draft, when the computer is offline across reloads, then its title survives and history recovers exactly once", async ({
            runtime,
        }, testInfo) => {
            const { page } = runtime;
            await page.clock.install({ time: new Date("2026-10-26T00:00:00Z") });
            const connected = await runtime.followInstructions("/doc/setup.md", "setup-reconnect-session");
            await page.goto(connected.url);
            const composer = page.getByRole("textbox", { name: "Message" });
            await expect(composer).toBeEnabled();
            await conversationLoaded(page);
            await composer.fill("Remember this offline conversation");
            await page.getByRole("button", { name: "Send message", exact: true }).click();
            await expect(page.getByRole("article", { name: "Agent response" })).toContainText(
                "Remember this offline conversation",
            );
            await composer.fill("Preserve this unsent follow-up");
            await page.getByTitle("Rename conversation", { exact: true }).click();
            await page.getByRole("textbox", { name: "Conversation title" }).fill("Offline refresh acceptance");
            await page.getByRole("button", { name: "Save title" }).click();
            await expect(page.getByRole("heading", { name: "Offline refresh acceptance", exact: true })).toBeVisible();
            await runtime.pauseRuntime();
            for (let reload = 0; reload < 2; reload += 1) {
                await page.reload();
                await expect(
                    page.getByRole("heading", { name: "Offline refresh acceptance", exact: true }),
                ).toBeVisible();
                await expect(page.getByRole("heading", { name: "New session", exact: true })).toHaveCount(0);
                await expect(page.getByRole("log", { name: "Messages" })).toContainText(
                    "History is temporarily unavailable. It will load when the connection returns.",
                );
                await expect(page.getByRole("alert")).toHaveCount(0);
            }
            await page.screenshot({ path: testInfo.outputPath("offline-refresh.png") });
            await runtime.resumeRuntime();
            await expect(composer).toBeEnabled();
            await expect(composer).toHaveValue("Preserve this unsent follow-up");
            await expect(
                page
                    .getByRole("article", { name: "Agent response" })
                    .filter({ hasText: "Remember this offline conversation" }),
            ).toHaveCount(1);
            await expect(page.getByRole("log", { name: "Messages" })).not.toContainText(
                "Preserve this unsent follow-up",
            );
            await expect(page.getByRole("heading", { name: "Offline refresh acceptance", exact: true })).toBeVisible();
            await page.screenshot({ path: testInfo.outputPath("history-restored.png") });
        });
    });
}
