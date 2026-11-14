import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { readyComposer, refreshSessions, sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

const ARCHIVED = "This Session was archived.";
const HELD_PROMPT = "hold after first delta";

function closedNoticeText(app: TestApp): string | null {
    const notice = app.optionalElementByTestId(dataTestId.sessionClosedNotice);
    return notice === null ? null : notice.textContent;
}

function sendButtonLabel(app: TestApp): string | null {
    return app.elementByTestId(dataTestId.sendMessage).getAttribute("aria-label");
}

async function openSavedConversation(app: TestApp): Promise<string> {
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    const draft = await readyComposer(app);
    await sendPrompt(app, draft, HELD_PROMPT);
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((entry) => entry.textContent?.includes("Partial reply")),
        ).toBe(true),
    );
    const sessionId = new URL(window.location.href).searchParams.get("sessionId");
    if (sessionId === null) {
        throw new Error("The opened conversation must have an address");
    }
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    await daemon.continueReply(HELD_PROMPT, { outcome: "complete", output: [] });
    await refreshSessions(app);
    await app.queryElementByTestId(
        dataTestId.sessionStatus,
        (element) => element.getAttribute("aria-label") === "Unread response",
    );
    const conversation = app
        .elementsByTestId(dataTestId.managedConversation)
        .find((candidate) => candidate.textContent?.includes(HELD_PROMPT));
    if (conversation === undefined) {
        throw new Error("Expected the saved conversation");
    }
    await app.user.click(conversation);
    await readyComposer(app);
    return sessionId;
}

test("Given a running reply, When another window archives the Session, Then this page closes it without a failed reply", async () => {
    const app = await createTestApp({ connectAgent: true });
    const sessionId = await openSavedConversation(app);
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    const composer = await readyComposer(app);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the composer");
    }
    await sendPrompt(app, composer, HELD_PROMPT);
    await app.waitForView(() => expect(sendButtonLabel(app)).toBe("Stop agent output"));
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .filter((entry) => entry.textContent?.includes("Partial reply")),
        ).toHaveLength(2),
    );

    await daemon.archiveSession(sessionId);

    await app.waitForView(() => expect(closedNoticeText(app)).toContain(ARCHIVED));
    await app.waitForView(() => expect(sendButtonLabel(app)).toBe("Send message"));
    expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull();
    expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
});
