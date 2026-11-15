import { getAllByRole, getByRole, queryByRole } from "@testing-library/dom";
import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";
import { createChatWorkerEnvironment, dedicatedEnvironmentTimeout } from "./support/chat-worker.ts";

test("Given a committed rename with a delayed reply, When I leave and another client renames before I return, Then returning keeps the newest title without resending the rename", {
    timeout: dedicatedEnvironmentTimeout,
}, async ({ signal }) => {
    const environment = await createChatWorkerEnvironment(false, true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Original title");
    await app.waitForView(() =>
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Original title"),
    );
    const sessionId = new URL(window.location.href).searchParams.get("sessionId");
    if (app.executionNetwork === null || app.daemon === null || sessionId === null) {
        throw new Error("Expected a connected session");
    }
    const held = app.executionNetwork.holdNextResponse("/rename");
    await app.user.click(getByRole(document.body, "button", { name: "Original title" }));
    const input = getByRole(document.body, "textbox", { name: "Conversation title" });
    await app.user.clear(input);
    await app.user.type(input, "Earlier rename");
    await app.user.click(getByRole(document.body, "button", { name: "Save title" }));
    const release = await held;
    onTestFinished(release);
    expect(await app.daemon.readSessionTitle(sessionId, signal)).toBe("Earlier rename");
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    await app.daemon.renameSession(sessionId, "Newest title", signal);
    expect(await app.daemon.readSessionTitle(sessionId, signal)).toBe("Newest title");
    await app.user.click(getByRole(document.body, "button", { name: "Refresh sessions" }));
    await app.waitForView(() => getByRole(document.body, "button", { name: "Open Newest title" }));
    await app.user.click(getByRole(document.body, "button", { name: "Open Newest title" }));
    release();
    await app.waitForView(() =>
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Original title"),
    );
    await app.waitForView(() =>
        expect(queryByRole(document.body, "textbox", { name: "Conversation title" })).toBeNull(),
    );
    expect(getAllByRole(document.body, "heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
        "Recent sessions",
        "Newest title",
    ]);
    expect(await app.daemon.readSessionTitle(sessionId, signal)).toBe("Newest title");
});

test("Given a newer live title, When an older rename acknowledgement arrives, Then the current title stays newer", {
    timeout: dedicatedEnvironmentTimeout,
}, async ({ signal }) => {
    const environment = await createChatWorkerEnvironment(false, true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Original scan title");
    await app.waitForView(() =>
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Original scan title"),
    );
    const sessionId = new URL(window.location.href).searchParams.get("sessionId");
    if (app.executionNetwork === null || app.daemon === null || sessionId === null) {
        throw new Error("Expected a connected session");
    }
    const held = app.executionNetwork.holdNextResponse("/rename");
    await app.user.click(getByRole(document.body, "button", { name: "Original scan title" }));
    const input = getByRole(document.body, "textbox", { name: "Conversation title" });
    await app.user.clear(input);
    await app.user.type(input, "Earlier rename");
    await app.user.click(getByRole(document.body, "button", { name: "Save title" }));
    const release = await held;
    onTestFinished(release);
    await app.daemon.renameSession(sessionId, "Newest observed title", signal);
    await app.waitForView(() => getByRole(document.body, "button", { name: "Open Newest observed title" }));
    release();
    await app.waitForView(() =>
        expect(queryByRole(document.body, "textbox", { name: "Conversation title" })).toBeNull(),
    );
    expect(getAllByRole(document.body, "heading", { level: 2 }).map((heading) => heading.textContent)).toContain(
        "Newest observed title",
    );
    // An acknowledgement must also refresh the title when live events have not arrived yet.
    const releaseEvents = app.executionNetwork.holdSessionEvents();
    onTestFinished(releaseEvents);
    await app.user.click(getByRole(document.body, "button", { name: "Newest observed title" }));
    const nextInput = getByRole(document.body, "textbox", { name: "Conversation title" });
    await app.user.clear(nextInput);
    await app.user.type(nextInput, "Title confirmed by a fresh read");
    await app.user.click(getByRole(document.body, "button", { name: "Save title" }));
    await app.waitForView(() =>
        getByRole(document.body, "heading", { level: 2, name: "Title confirmed by a fresh read" }),
    );
});

test("Given a directory refresh already read an open session, When I close it before the reply arrives, Then the late directory does not restore it", {
    timeout: dedicatedEnvironmentTimeout,
}, async () => {
    const environment = await createChatWorkerEnvironment(false, true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Close during refresh");
    await app.waitForView(() =>
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Close during refresh"),
    );
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    if (app.executionNetwork === null) {
        throw new Error("Expected a connected session");
    }
    // The directory is the Computer's Session list.
    const held = app.executionNetwork.holdNextResponse("/managed-sessions");
    await app.user.click(getByRole(document.body, "button", { name: "Refresh sessions" }));
    const release = await held;
    onTestFinished(release);
    await app.user.pointer({
        keys: "[MouseRight]",
        target: getByRole(document.body, "button", { name: "Open Close during refresh" }),
    });
    await app.user.click(await app.waitForView(() => getByRole(document.body, "menuitem", { name: "Close session" })));
    await app.waitForView(() => expect(app.elementsByTestId(dataTestId.managedConversation)).toHaveLength(0));
    release();
    await app.waitForView(() => getByRole(document.body, "button", { name: "Refresh sessions" }));
    expect(app.elementsByTestId(dataTestId.managedConversation)).toHaveLength(0);
});
