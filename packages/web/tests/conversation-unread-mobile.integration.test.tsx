import { getByRole } from "@testing-library/dom";
import type { DetachedWindowAPI } from "happy-dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { readyComposer, sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

declare global {
    interface Window {
        readonly happyDOM: DetachedWindowAPI;
    }
}

const HELD_PROMPT = "hold after first delta";

test("Given a reply finished in another session on a phone, When the user looks at the header, Then the Recent sessions icon shows an unread dot until that session is opened", {
    timeout: 30_000,
}, async () => {
    const desktopViewport = { height: window.innerHeight, width: window.innerWidth };
    window.happyDOM.setViewport({ height: 844, width: 413 });
    let app: TestApp | null = null;
    try {
        app = await createTestApp({ connectAgent: true });
        const daemon = app.daemon;
        if (daemon === null) {
            throw new Error("Expected a connected controlled Agent Runtime");
        }
        const composer = await readyComposer(app);
        await sendPrompt(app, composer, HELD_PROMPT);
        await app.waitForView(() =>
            expect(
                app
                    ?.elementsByTestId(dataTestId.agentResponse)
                    .some((element) => element.textContent?.includes("Partial reply")),
            ).toBe(true),
        );
        await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
        const recentSessions = () => getByRole(document.body, "button", { name: /^Recent sessions/u });
        expect(app.optionalElementByTestId(dataTestId.mobileRecentSessionsUnread)).toBeNull();

        await daemon.continueReply(HELD_PROMPT, { outcome: "complete", output: [] });
        const trigger = recentSessions();
        await app.user.click(trigger);
        const sheet = await app.queryElementByTestId(dataTestId.mobileRecentSessionsSheet);
        await app.user.click(getByRole(sheet, "button", { name: "Refresh sessions" }));
        const dot = await app.queryElementByTestId(dataTestId.mobileRecentSessionsUnread);
        expect(trigger.contains(dot)).toBe(true);
        expect(trigger.getAttribute("aria-label")).toBe("Recent sessions, unread replies");

        const unreadConversation = app
            .elementsByTestId(dataTestId.managedConversation)
            .find((element) => sheet.contains(element) && element.textContent?.includes(HELD_PROMPT) === true);
        if (unreadConversation === undefined) {
            throw new Error("Expected the completed conversation in the sheet");
        }
        await app.user.click(unreadConversation);
        await app.waitForView(() => {
            expect(app?.optionalElementByTestId(dataTestId.mobileRecentSessionsUnread)).toBeNull();
            expect(recentSessions().getAttribute("aria-label")).toBe("Recent sessions");
        });
    } finally {
        if (app !== null) {
            await app.close();
        }
        window.happyDOM.setViewport(desktopViewport);
    }
});
