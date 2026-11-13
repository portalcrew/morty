import { fireEvent, getAllByRole, getByRole, queryByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";
import { createChatWorkerEnvironment } from "./support/chat-worker.ts";

test("Given Chat is ready, When the user views recent sessions and opens a local session, Then every action uses session terminology", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    expect(getByRole(document.body, "heading", { name: "Recent sessions" })).toBeDefined();
    expect(getByRole(document.body, "button", { name: "New Session" })).toBeDefined();
    const open = getByRole(document.body, "button", { name: "Open Session" });
    const discovering = app.waitForView(() => {
        const status = queryByRole(document.body, "status", {
            name: "Discovering native sessions",
        });
        if (status === null) {
            throw new Error("The native session loading placeholder is not visible.");
        }
        return status;
    });

    await app.user.click(open);

    await discovering;
    const dialog = await app.waitForView(() => getByRole(document.body, "dialog", { name: "Open Session" }));
    await app.waitForView(() => {
        if (queryByRole(dialog, "status", { name: "Discovering native sessions" }) !== null) {
            throw new Error("The native session dialog is still discovering sessions.");
        }
        return getByRole(dialog, "region", { name: "Selected session preview" });
    });
    expect(queryByRole(dialog, "button", { name: "Import" })).toBeNull();
    const preview = getByRole(dialog, "region", {
        name: "Selected session preview",
    });
    expect(preview.textContent).toContain("Select a session");
    expect(preview.textContent).toContain("Preview its message history here.");
    // Nothing is previewed, so the actions that need a session must not be offered.
    expect(queryByRole(dialog, "button", { name: "Open" })).toBeNull();
    expect(queryByRole(dialog, "button", { name: "Fork" })).toBeNull();
});

test("Given the first agent lists saved sessions, When the user opens Open Session, Then the first session is already previewed", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        connectAgent: true,
        sessionIds: new Set(["first-session", "second-session"]),
    });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    await app.user.click(getByRole(document.body, "button", { name: "Open Session" }));
    const dialog = await app.waitForView(() => getByRole(document.body, "dialog", { name: "Open Session" }));
    // The preview region is re-rendered while its content loads, so each assertion resolves it from the dialog.
    await app.waitForView(() =>
        getByRole(getByRole(dialog, "region", { name: "Selected session preview" }), "heading", {
            name: "Native first-session",
        }),
    );
    const first = getByRole(dialog, "button", { name: "Native first-session" });
    expect(first.getAttribute("aria-pressed")).toBe("true");
    expect(getByRole(dialog, "button", { name: "Native second-session" }).getAttribute("aria-pressed")).toBe("false");
    expect(getByRole(dialog, "button", { name: "Open" }).hasAttribute("disabled")).toBe(false);
});

test("Given Pi is not installed on the Computer, When the user opens Open Session and selects Pi, Then the dialog explains Pi is not installed", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    await app.user.click(getByRole(document.body, "button", { name: "Open Session" }));
    const dialog = await app.waitForView(() => getByRole(document.body, "dialog", { name: "Open Session" }));
    const tablist = await app.waitForView(() => getByRole(dialog, "tablist", { name: "Session agent" }));
    const pi = getByRole(tablist, "tab", { name: "Pi not installed" });
    await app.user.click(pi);
    await app.waitForView(() => {
        expect(dialog.textContent).toContain("Pi is not installed");
        expect(dialog.textContent).toContain("Install it on this computer to browse saved sessions.");
    });
});

test("Given Pi is installed on the Computer, When the user opens Open Session, Then Pi appears once in the agent tabs", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true, agent: { harness: "pi", label: "Pi" } });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    await app.user.click(getByRole(document.body, "button", { name: "Open Session" }));
    const dialog = await app.waitForView(() => getByRole(document.body, "dialog", { name: "Open Session" }));
    const tablist = await app.waitForView(() => getByRole(dialog, "tablist", { name: "Session agent" }));
    expect(getAllByRole(tablist, "tab", { name: "Pi" })).toHaveLength(1);
});

test("Given native sessions are available, When the user opens Open Session, Then the sheet lists them inline with their directory and previews a tap", {
    timeout: 30_000,
}, async () => {
    const longSessionId = "session-two-with-a-title-that-is-long-enough-to-overflow-a-mobile-menu";
    const longSessionTitle = `Native ${longSessionId}`;
    const app = await createTestApp({
        connectAgent: true,
        sessionIds: new Set(["session-one", longSessionId]),
    });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    await app.user.click(getByRole(document.body, "button", { name: "Open Session" }));
    const dialog = await app.waitForView(() => getByRole(document.body, "dialog", { name: "Open Session" }));
    // The phone sheet lists the sessions itself: there is no menu to open first, and each row's
    // name carries its directory so same-titled sessions stay tellable apart.
    expect(queryByRole(dialog, "combobox", { name: "Native session" })).toBeNull();
    const row = await app.waitForView(() => getByRole(dialog, "button", { name: `${longSessionTitle} /` }));
    expect(row.textContent).toContain(longSessionTitle);
    act(() => fireEvent.click(row));

    const preview = getByRole(document.body, "region", {
        name: "Selected session preview",
    });
    await app.waitForView(() => getByRole(preview, "heading", { name: longSessionTitle }));
});

test("Given the phone sheet lists sessions, When the user taps one, Then the sheet shows its detail with a way back to the list", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        connectAgent: true,
        sessionIds: new Set(["first-session", "second-session"]),
    });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    await app.user.click(getByRole(document.body, "button", { name: "Open Session" }));
    const dialog = await app.waitForView(() => getByRole(document.body, "dialog", { name: "Open Session" }));
    const row = await app.waitForView(() => getByRole(dialog, "button", { name: "Native second-session /" }));
    // The sheet opens on the list step, with no detail chrome yet.
    expect(queryByRole(dialog, "button", { name: "Back to session list" })).toBeNull();
    await app.user.click(row);

    const back = await app.waitForView(() => getByRole(dialog, "button", { name: "Back to session list" }));
    const preview = getByRole(dialog, "region", { name: "Selected session preview" });
    await app.waitForView(() => getByRole(preview, "heading", { name: "Native second-session" }));
    expect(getByRole(dialog, "button", { name: "Open" })).toBeDefined();

    await app.user.click(back);
    await app.waitForView(() => {
        expect(queryByRole(dialog, "button", { name: "Back to session list" })).toBeNull();
        expect(getByRole(dialog, "button", { name: "Native second-session /" }).getAttribute("aria-pressed")).toBe(
            "true",
        );
    });
});

test("Given the user previewed a session, When they close Open Session and open it again, Then the same session is still selected", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        connectAgent: true,
        sessionIds: new Set(["first-session", "second-session"]),
    });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    await app.user.click(getByRole(document.body, "button", { name: "Open Session" }));
    const dialog = await app.waitForView(() => getByRole(document.body, "dialog", { name: "Open Session" }));
    const second = await app.waitForView(() => getByRole(dialog, "button", { name: "Native second-session" }));
    await app.user.click(second);
    await app.waitForView(() => expect(second.getAttribute("aria-pressed")).toBe("true"));

    await app.user.click(getByRole(dialog, "button", { name: "Close dialog" }));
    await app.waitForView(() => {
        if (queryByRole(document.body, "dialog", { name: "Open Session" }) !== null) {
            throw new Error("The Open Session dialog is still open.");
        }
    });
    await app.user.click(getByRole(document.body, "button", { name: "Open Session" }));
    const reopened = await app.waitForView(() => getByRole(document.body, "dialog", { name: "Open Session" }));
    await app.waitForView(() =>
        expect(getByRole(reopened, "button", { name: "Native second-session" }).getAttribute("aria-pressed")).toBe(
            "true",
        ),
    );
});

test("Given native sessions were discovered before the Computer disconnected, When a preview fails, Then Open Session shows one error with one bug report action", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true, sessionIds: new Set(["preview-error-session"]) });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    await app.user.click(getByRole(document.body, "button", { name: "Open Session" }));
    const entry = await app.waitForView(() =>
        getByRole(document.body, "button", { name: "Native preview-error-session" }),
    );
    if (app.daemon === null) {
        throw new Error("The scenario requires a connected Computer.");
    }
    await app.daemon.disconnect();
    act(() => fireEvent.click(entry));
    const dialog = getByRole(document.body, "dialog", { name: "Open Session" });
    await app.waitForView(() => {
        expect(getAllByRole(dialog, "alert")).toHaveLength(1);
        expect(getAllByRole(dialog, "button", { name: "Report a bug" })).toHaveLength(1);
    });
    await app.user.click(getByRole(dialog, "button", { name: "Report a bug" }));
    await app.waitForView(() => getByRole(document.body, "dialog", { name: "Report a bug" }));
});

test("Given Open Session was opened while the Computer was offline, When the Computer comes back online, Then the open dialog lists its sessions without reopening", {
    timeout: 60_000,
}, async () => {
    const clock = new TestClock("2026-10-24T08:00:00Z");
    const app = await createTestApp({
        connectAgent: true,
        sessionIds: new Set(["session-after-reconnect"]),
        clock,
    });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("The scenario requires a connected Computer.");
    }
    const connection = (): string | null =>
        app.elementByTestId(dataTestId.botConnectionStatus).getAttribute("data-connection-status");
    await app.waitForView(() => expect(connection()).toBe("connected"));

    await daemon.disconnect();
    await app.waitForView(() => expect(connection()).toBe("disconnected"));
    await app.user.click(getByRole(document.body, "button", { name: "Open Session" }));
    const dialog = await app.waitForView(() => getByRole(document.body, "dialog", { name: "Open Session" }));
    await app.waitForView(() => expect(dialog.textContent).toContain("No local agent"));

    await daemon.reconnect();
    await app.waitForView(() => expect(connection()).toBe("connected"));
    await app.waitForView(() => getByRole(dialog, "button", { name: "Native session-after-reconnect" }));
    await app.waitForView(() => getByRole(dialog, "button", { name: "Native session-after-reconnect /" }));
    expect(dialog.textContent).not.toContain("No local agent");
});

test("Given an old native preview response, When the selected Agent changes, Then the old preview cannot appear under the new Agent", {
    timeout: 60_000,
}, async () => {
    const environment = await createChatWorkerEnvironment(false, true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({
        environment,
        connectAgent: true,
        sessionIds: new Set(["previous-agent-session"]),
    });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    if (app.executionNetwork === null) {
        throw new Error("Expected controllable real transport");
    }
    const held = app.executionNetwork.holdNextResponse("/native-sessions/previous-agent-session");
    await app.user.click(getByRole(document.body, "button", { name: "Open Session" }));
    const release = await held;
    onTestFinished(release);
    const dialog = getByRole(document.body, "dialog", { name: "Open Session" });
    await app.user.click(getByRole(dialog, "tab", { name: "Pi not installed" }));
    expect(dialog.textContent).toContain("Pi is not installed");
    await act(async () => {
        release();
        // Complete a real HTTP round trip after forwarding the held response.
        const response = await fetch(app.origin, { signal: AbortSignal.timeout(10_000) });
        await response.text();
    });
    expect(queryByRole(dialog, "heading", { name: "Native previous-agent-session" })).toBeNull();
    expect(queryByRole(dialog, "button", { name: "Fork" })).toBeNull();
});
