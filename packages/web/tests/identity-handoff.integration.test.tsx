import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getByRole, getByTestId, queryByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import * as v from "valibot";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { centralLocalStorage, linkedDevicesSeenEntry } from "../src/services/local-storage/central-local-storage.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

async function openDesktopUserMenu(app: TestApp) {
    await app.user.click(await app.queryElementByTestId(dataTestId.userMenu));
}

async function clickDesktopEndRemoteAccess(app: TestApp) {
    await openDesktopUserMenu(app);
    await app.user.click(await app.queryElementByTestId(dataTestId.endRemoteAccess));
}

test("Given a stored identity for the active Computer, When the user shares access, Then a copyable transfer link and QR code appear", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true, page: { kind: "bootstrap", identity: true } });
    await app.user.click(await app.queryElementByTestId(dataTestId.shareIdentity));
    const sharing = await app.queryElementByTestId(dataTestId.identitySharing);
    const image = getByRole(sharing, "img", { name: "Continue on another device QR code" });
    expect(image.getAttribute("src")).toMatch(/^data:image\/png;base64,/u);
    await app.user.click(getByRole(sharing, "button", { name: "Copy link" }));
    const url = new URL(await navigator.clipboard.readText());
    expect(url.origin).toBe(app.origin);
    expect(url.pathname).toBe("/continue");
    expect(url.hash).toMatch(/^#code=\S+$/u);
    expect(getByRole(sharing, "button", { name: "Copied" })).toBeInstanceOf(HTMLButtonElement);
    expect(queryByRole(sharing, "alert")).toBeNull();
});

test("Given a native session handoff, When the page loads, Then it shows the shared centered loading mark instead of a continue card", {
    timeout: 30_000,
}, async () => {
    const sessionId = "01a0d270-0d62-7003-98df-22a5d11dc644";
    const app = await createTestApp({
        agent: { harness: "pi", label: "Pi" },
        connectAgent: true,
        sessionIds: new Set([sessionId]),
        page: { harness: "pi", kind: "continue", sessionId },
    });

    const loading = await app.waitForView(() => getByRole(document.body, "status", { name: "Opening session" }));
    expect(loading).toBeInstanceOf(HTMLElement);
    expect(loading.querySelectorAll("[data-loading-petal]")).toHaveLength(4);
    expect(queryByRole(document.body, "heading", { name: "Continue native session" })).toBeNull();
    expect(document.body.textContent).not.toContain("Opening the original session in Morty.");
    expect(document.body.textContent).not.toContain("Opening session…");
    expect(queryByRole(document.body, "button", { name: "Open session" })).toBeNull();
    expect(queryByRole(document.body, "button", { name: "Fork session" })).toBeNull();
    expect(queryByRole(document.body, "button", { name: "Go to Morty" })).toBeNull();
    expect(queryByRole(document.body, "img", { name: "QR code to continue on another device" })).toBeNull();
    expect(queryByRole(document.body, "button", { name: "Show QR code" })).toBeNull();
});

test("Given a native session handoff, When the page loads, Then the loading surface has no top navigation", {
    timeout: 30_000,
}, async () => {
    const sessionId = "01a0d270-0d62-7003-98df-22a5d11dc644";
    const app = await createTestApp({
        agent: { harness: "pi", label: "Pi" },
        connectAgent: true,
        sessionIds: new Set([sessionId]),
        page: { harness: "pi", kind: "continue", sessionId },
    });

    await app.waitForView(() => getByRole(document.body, "status", { name: "Opening session" }));
    expect(document.body.textContent).not.toContain("Your agents. Connected.");
    expect(document.body.querySelector("header")).toBeNull();
    expect(queryByRole(document.body, "link", { name: "Morty home" })).toBeNull();
});

test("Given a new browser, When Morty loads, Then Morty opens without presenting a workspace concept", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap" } });

    expect(
        await app.waitForView(() =>
            getByRole(document.body, "heading", { name: "Step away. Keep your agent working." }),
        ),
    ).toBeInstanceOf(HTMLElement);
    expect(document.body.textContent).not.toContain("Local agents");
    expect(document.body.textContent?.toLowerCase()).not.toContain("workspace");
});

test("Given Morty access from a finished setup, When the user reopens Morty in a fresh browser session, Then the chat opens directly with the identity kept in the address", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap", identity: true }, connectAgent: true });

    expect(await app.queryElementByTestId(dataTestId.chatLanding)).toBeInstanceOf(HTMLElement);
    expect(queryByRole(document.body, "heading", { name: "Step away. Keep your agent working." })).toBeNull();
    expect(window.location.search).toContain("identity=");
    expect(window.sessionStorage.getItem("morty.anonymous-credential.v2")).toBeNull();
});

test("Given a stored identity, When the user shares access with an AI agent, Then copyable instructions name the agent API document and a link the agent can redeem as documented", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock("2026-11-13T08:00:00Z");
    const app = await createTestApp({ clock, connectAgent: true, page: { kind: "bootstrap", identity: true } });
    await app.user.click(await app.queryElementByTestId(dataTestId.shareIdentity));
    const dialog = getByRole(document.body, "dialog", { name: "Continue on another device" });
    await app.waitForView(() => getByRole(dialog, "button", { name: "Copy link" }));
    await app.user.click(getByRole(dialog, "combobox", { name: "Share with" }));
    await app.user.click(getByRole(document.body, "option", { name: "An AI agent" }));
    expect(getByRole(dialog, "status").textContent).toContain("Preparing agent instructions");
    expect(queryByRole(dialog, "button", { name: "Copy instructions" })).toBeNull();
    await act(async () => clock.advanceBy(250));

    const handoff = getByTestId(dialog, dataTestId.agentHandoff);
    expect(queryByRole(dialog, "img", { name: "Continue on another device QR code" })).toBeNull();
    expect(handoff.textContent).toContain("Works for one device until");
    await app.user.click(getByRole(handoff, "button", { name: "Copy instructions" }));
    const instructions = await navigator.clipboard.readText();
    expect(instructions).toContain(`${app.origin}/doc/agent-api.md`);
    const link = instructions.split("\n").find((line) => line.startsWith(`${app.origin}/continue`));
    if (link === undefined) {
        throw new Error("The agent instructions must contain the continue link.");
    }

    const guide = await app.transport.request(new Request(new URL("/doc/agent-api.md", app.origin)));
    expect(guide.status).toBe(200);
    const guideText = await guide.text();
    expect(guideText).toContain(`${app.origin}/doc/agent-api/openapi.json`);
    expect(guideText).toContain(`Morty origin: ${app.origin}`);
    const redeemed = await app.transport.request(
        new Request(new URL("/morty/api/v1/identity/transfers/redeem", app.origin), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                code: new URLSearchParams(new URL(link).hash.slice(1)).get("code"),
                redemptionKey: "A".repeat(43),
                device: "Test agent",
            }),
            signal: AbortSignal.timeout(15_000),
        }),
    );
    expect(redeemed.status).toBe(200);
    expect(await redeemed.json()).toEqual({ computerToken: expect.any(String), computerId: expect.any(String) });

    // Switching back shows the same link to a person; choosing a recipient never issues another link.
    await app.user.click(getByRole(dialog, "combobox", { name: "Share with" }));
    await app.user.click(getByRole(document.body, "option", { name: "A person" }));
    expect(getByRole(dialog, "status").textContent).toContain("Preparing sharing details");
    await act(async () => clock.advanceBy(250));
    await app.user.click(getByRole(dialog, "button", { name: "Copy link" }));
    expect(await navigator.clipboard.readText()).toBe(link);
});

test("Given shared Morty access, When the user continues on another device, Then the visible entry opens sharing with its scope and expiry before the link", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap", identity: true } });
    await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));
    await app.connectAgent();
    await app.user.click(await app.queryElementByTestId(dataTestId.shareIdentity));

    const dialog = getByRole(document.body, "dialog", { name: "Continue on another device" });
    expect(getByRole(dialog, "alert").textContent).toContain(
        "Anyone who opens this link can view and control every session on this computer",
    );
    const copyLink = await app.waitForView(() => getByRole(dialog, "button", { name: "Copy link" }));
    expect(getByRole(dialog, "img", { name: "Continue on another device QR code" })).toBeInstanceOf(HTMLImageElement);
    expect(dialog.textContent).toContain("Works for one device until");
    expect(dialog.textContent).toContain("That device keeps access until");
    const description = getByRole(dialog, "heading", { name: "Continue on another device" }).parentElement;
    if (description === null) {
        throw new Error("The sharing description must precede its copy-link button.");
    }
    expect(description.compareDocumentPosition(copyLink) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(queryByRole(dialog, "link")).toBeNull();
    expect(queryByRole(dialog, "button", { name: "Confirm" })).toBeNull();

    // Choosing a longer device access shares a new link in place of the one shown, with the term it grants.
    const qr = () => getByRole(dialog, "img", { name: "Continue on another device QR code" }).getAttribute("src");
    const dayLink = qr();
    const dayTerms = dialog.textContent;
    await app.user.click(getByRole(dialog, "combobox", { name: "Device access" }));
    await app.user.click(getByRole(document.body, "option", { name: "7 days" }));
    await app.waitForView(() => expect(dialog.textContent).toContain("The previous link no longer works."));
    expect(qr()).not.toBe(dayLink);
    expect(dialog.textContent).not.toBe(dayTerms);
});

test("Given a native session handoff without a matching Agent, When the page loads, Then opening fails with the reason", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        agent: { harness: "codex", label: "Codex" },
        connectAgent: true,
        page: {
            harness: "pi",
            kind: "continue",
            sessionId: "01a0d270-0d62-7003-98df-22a5d11dc644",
        },
    });

    const alert = await app.waitForView(() => getByRole(document.body, "alert"));
    expect(alert.textContent).toContain("handoff harness is unavailable");
    expect(getByRole(document.body, "heading", { name: "Couldn't open this session" })).toBeInstanceOf(HTMLElement);
    expect(queryByRole(document.body, "button", { name: "Fork session" })).toBeNull();
});

test("Given opening a native session fails, When the user tries again, Then the page re-runs the same open-session request", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        page: {
            harness: "pi",
            kind: "continue",
            sessionId: "01a0d270-0d62-7003-98df-22a5d11dc644",
        },
    });
    await app.waitForView(() => {
        expect(getByRole(document.body, "alert").textContent).toContain("Connect an Agent to this Computer first.");
    });

    // The retry must run the whole open-session request again: once a Computer answers
    // for the redeemed access, the failure moves from the missing Agent to the
    // missing native session.
    await app.connectAgent({ harness: "pi", label: "Pi" });
    await app.user.click(getByRole(document.body, "button", { name: "Try again" }));

    await app.waitForView(() => {
        expect(getByRole(document.body, "alert").textContent).toContain("The native session was not found");
    });
    expect(getByRole(document.body, "button", { name: "Try again" })).toBeInstanceOf(HTMLButtonElement);
});

test("Given the Morty access was redeemed and opening the original session failed, When the user views the failure page, Then they see the reason, retry, and an entry into Morty", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        agent: { harness: "pi", label: "Pi" },
        connectAgent: true,
        page: {
            harness: "pi",
            kind: "continue",
            sessionId: "01a0d270-0d62-7003-98df-22a5d11dc644",
        },
    });

    const alert = await app.waitForView(() => getByRole(document.body, "alert"));
    expect(alert.textContent).toContain("The native session was not found");
    expect(getByRole(document.body, "heading", { name: "Couldn't open this session" })).toBeInstanceOf(HTMLElement);
    expect(getByRole(document.body, "button", { name: "Try again" })).toBeInstanceOf(HTMLButtonElement);
    expect(getByRole(document.body, "button", { name: "Go to Morty" })).toBeInstanceOf(HTMLButtonElement);

    await app.user.click(getByRole(document.body, "button", { name: "Try again" }));

    await app.waitForView(() => {
        expect(getByRole(document.body, "alert").textContent).toContain("The native session was not found");
    });
    expect(getByRole(document.body, "button", { name: "Go to Morty" })).toBeInstanceOf(HTMLButtonElement);
});

test("Given an expired handoff with no retained access, When the failure page shows, Then it explains how to get a new link without offering an ineffective retry", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        page: {
            code: (application) => `morty_transfer_v1.${application.identity.computerId}.${"a".repeat(43)}`,
            harness: "pi",
            kind: "continue",
            sessionId: "01a0d270-0d62-7003-98df-22a5d11dc644",
        },
    });

    const alert = await app.waitForView(() => getByRole(document.body, "alert"));
    expect(alert.textContent).toContain(
        "This link was already used, has expired, or was revoked. Run setup again on that computer.",
    );
    expect(getByRole(document.body, "heading", { name: "This link is no longer available" })).toBeDefined();
    expect(queryByRole(document.body, "button", { name: "Go to Morty" })).toBeNull();
    expect(queryByRole(document.body, "button", { name: "Try again" })).toBeNull();
    expect(document.body.textContent).toContain("Next: paste it into the agent running on your computer.");
    expect(queryByRole(document.body, "textbox", { name: "Agent setup prompt" })).toBeNull();
    expect(document.body.textContent).not.toContain("complete the Morty setup for me");
    expect(document.body.textContent).not.toContain("Review what setup does");
    expect(document.body.textContent).not.toContain("Setup interrupts the agent's current task");
    expect(queryByRole(document.body, "group", { name: "Setup details" })).toBeNull();
});

test("Given an expired handoff with no retained access, When the user copies the setup prompt, Then the clipboard holds the instruction and no toast appears", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        page: {
            code: (application) => `morty_transfer_v1.${application.identity.computerId}.${"a".repeat(43)}`,
            harness: "pi",
            kind: "continue",
            sessionId: "01a0d270-0d62-7003-98df-22a5d11dc644",
        },
    });

    const copy = await app.waitForView(() => getByRole(document.body, "button", { name: "Copy setup prompt" }));
    await app.user.click(copy);

    expect(await navigator.clipboard.readText()).toBe(
        `Fetch ${window.location.origin}/doc/setup.md and complete the Morty setup for me. You may install missing prerequisites and pair this computer.`,
    );
    expect(getByRole(document.body, "button", { name: "Copied" })).toBeInstanceOf(HTMLButtonElement);
    expect(queryByRole(document.body, "button", { name: "Dismiss notification" })).toBeNull();
    expect(getByRole(document.body, "status", { name: "Setup next step" }).textContent).toContain(
        "Paste into your agent, then open the link it returns.",
    );
});

test("Given a native session handoff whose Computer went offline, When the page loads, Then the page reports Morty is disconnected instead of a transfer-link problem", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        prepare: async (application) => {
            const runtime = await application.connectAgent({ harness: "claude", label: "Claude" });
            await runtime.disconnect();
        },
        page: {
            harness: "claude",
            kind: "continue",
            sessionId: "01a0d270-0d62-7003-98df-22a5d11dc644",
        },
    });

    const alert = await app.waitForView(() => getByRole(document.body, "alert"));
    expect(alert.textContent).toContain("Your Morty Computer is disconnected");
    expect(alert.textContent).toContain("Start your Morty Computer");
    expect(alert.textContent?.toLowerCase()).not.toContain("transfer link");
    expect(getByRole(document.body, "button", { name: "Try again" })).toBeInstanceOf(HTMLButtonElement);
});

test("Given shared Morty access, When the user opens the user menu, Then replacing the current user is unavailable", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp();
    await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));
    await app.user.click(await app.queryElementByTestId(dataTestId.userMenu));

    expect(queryByRole(document.body, "menuitem", { name: "Replace current user" })).toBeNull();
});

test("Given one Morty Worker and a connected Computer, When the user refreshes Network latency, Then browser-to-Morty and Morty-to-Computer measurements update without retired Relay hops", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    await app.user.click(await app.queryElementByTestId(dataTestId.userMenu));
    await app.user.click(getByRole(document.body, "menuitem", { name: "Network latency" }));

    const dialog = getByRole(document.body, "dialog", { name: "Network latency" });
    await app.waitForView(() => {
        expect(dialog.textContent).toContain("Relay location: Western North America");
        expect(dialog.textContent).toContain("Browser ↔ Morty");
        expect(dialog.textContent).not.toContain("Browser ↔ Relay");
        expect(dialog.textContent).not.toContain("Morty ↔ Relay");
        expect(dialog.textContent).toContain("Morty ↔ Computer");
        expect(getByRole(dialog, "status", { name: "Browser to Morty latency" }).textContent).toMatch(/^\d+ ms$/u);
        expect(getByRole(dialog, "status", { name: "Morty to Computer latency" }).textContent).toMatch(/^\d+ ms$/u);
    });

    await app.user.click(getByRole(dialog, "button", { name: "Refresh network latency" }));

    expect(getByRole(dialog, "status", { name: "Measuring network latency" })).toBeInstanceOf(HTMLElement);
    await app.waitForView(() => {
        expect(getByRole(dialog, "status", { name: "Browser to Morty latency" }).textContent).toMatch(/^\d+ ms$/u);
        expect(getByRole(dialog, "status", { name: "Morty to Computer latency" }).textContent).toMatch(/^\d+ ms$/u);
    });
});

test("Given current Morty access, When the user opens its visible end action, Then the confirmation explains conditional scope without promising immediate disconnection", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap", identity: true } });
    await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));
    await clickDesktopEndRemoteAccess(app);

    const dialog = await app.queryElementByTestId(dataTestId.endRemoteAccessDialog);
    await app.waitForView(() =>
        expect(getByRole(dialog, "button", { name: "End current access" }).hasAttribute("disabled")).toBe(false),
    );
    expect(dialog.textContent).toContain("This browser loses access to your computer");
    expect(dialog.textContent).toContain("links you already shared still work until they expire");
    expect(dialog.textContent).toContain("Your local agent and tasks keep running");
    expect(queryByRole(dialog, "textbox", { name: "Current user token" })).toBeNull();
    await app.user.click(getByRole(dialog, "button", { name: "Cancel" }));
    expect(queryByRole(document.body, "dialog", { name: "End current access?" })).toBeNull();
    expect(getByRole(document.body, "button", { name: "Continue on another device" })).toBeInstanceOf(
        HTMLButtonElement,
    );
});

test("Given current Morty access, When ending succeeds, Then the setup page confirms this access ended after reloading", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap", identity: true } });
    await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));
    await clickDesktopEndRemoteAccess(app);
    const dialog = await app.queryElementByTestId(dataTestId.endRemoteAccessDialog);
    const confirm = await app.waitForView(() => {
        const button = getByRole(dialog, "button", { name: "End current access" });
        expect(button.hasAttribute("disabled")).toBe(false);
        return button;
    });
    await app.user.click(confirm);
    await app.waitForView(() => expect(window.location.search).not.toContain("identity="));
    await app.close();

    const reloaded = await createTestApp({ page: { kind: "bootstrap" } });
    await reloaded.waitForView(() =>
        expect(getByRole(document.body, "status").textContent).toContain("Current access ended"),
    );
    expect(document.body.textContent).toContain("Your local agent and tasks keep running");
    expect(getByRole(document.body, "heading", { name: "Step away. Keep your agent working." })).toBeInstanceOf(
        HTMLElement,
    );
    await reloaded.close();
    const nextVisit = await createTestApp({ page: { kind: "bootstrap" } });
    await nextVisit.waitForView(() =>
        getByRole(document.body, "heading", { name: "Step away. Keep your agent working." }),
    );
    expect(queryByRole(document.body, "status")).toBeNull();
});

test("Given the end confirmation, When the real API transport closes, Then an uncertain result is shown without claiming the access ended", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap", identity: true }, connectAgent: true });
    await clickDesktopEndRemoteAccess(app);
    const dialog = await app.queryElementByTestId(dataTestId.endRemoteAccessDialog);
    const confirm = await app.waitForView(() => {
        const button = getByRole(dialog, "button", { name: "End current access" });
        expect(button.hasAttribute("disabled")).toBe(false);
        return button;
    });
    app.transport.disconnect();
    // A dropped bridge is an ordinary failed request: Chat keeps working and
    // does not block the page with a connection dialog.
    expect(queryByRole(document.body, "dialog", { name: "Computer connection unavailable" })).toBeNull();
    await app.user.click(confirm);

    await app.waitForView(() =>
        expect(getByRole(dialog, "alert").textContent).toContain("We couldn't confirm whether this access ended"),
    );
    expect(getByRole(dialog, "button", { name: "Try again" })).toBeInstanceOf(HTMLButtonElement);
    expect(window.location.search).toContain("identity=");
    expect(document.body.textContent).not.toContain("Current access ended");
    app.transport.open();
    await app.user.click(getByRole(dialog, "button", { name: "Try again" }));
    await app.waitForView(() => expect(window.location.search).not.toContain("identity="));
});

test("Given an end confirmation for access revoked elsewhere, When the API rejects the request, Then Morty explains that the current access ended", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap", identity: true }, connectAgent: true });
    await clickDesktopEndRemoteAccess(app);
    const dialog = await app.queryElementByTestId(dataTestId.endRemoteAccessDialog);
    const confirm = await app.waitForView(() => {
        const button = getByRole(dialog, "button", { name: "End current access" });
        expect(button.hasAttribute("disabled")).toBe(false);
        return button;
    });
    const signal = new AbortController().signal;
    const revoked = await app.transport.request(
        new Request(`${app.origin}/morty/api/v1/computers/${app.identity.computerId}/identity/local-credential`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${await app.identity.getToken(signal)}` },
            signal,
        }),
    );
    expect(revoked.status).toBe(204);
    await app.user.click(confirm);
    await app.waitForView(() =>
        expect(getByRole(document.body, "status").textContent).toContain("Current access ended"),
    );
    expect(queryByRole(document.body, "dialog", { name: "End current access?" })).toBeNull();
});

test("Given an unavailable connection, When current access cannot be prepared, Then the user sees a retryable error and can return to confirmation", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap", identity: true }, connectAgent: true });
    await app.waitForView(() => getByRole(document.body, "button", { name: "User menu" }));
    app.transport.disconnect();
    expect(queryByRole(document.body, "dialog", { name: "Computer connection unavailable" })).toBeNull();
    await clickDesktopEndRemoteAccess(app);
    const dialog = await app.queryElementByTestId(dataTestId.endRemoteAccessDialog);
    await app.waitForView(() =>
        expect(getByRole(dialog, "alert").textContent).toContain("Couldn't prepare to end this access"),
    );
    app.transport.open();
    await app.user.click(getByRole(dialog, "button", { name: "Try again" }));
    await app.waitForView(() =>
        expect(getByRole(dialog, "button", { name: "End current access" }).hasAttribute("disabled")).toBe(false),
    );
    await app.user.click(getByRole(dialog, "button", { name: "Cancel" }));
    expect(window.location.search).toContain("identity=");
});

test("Given an expired sharing link with no retained access, When I open it, Then it asks for a new link without offering retry", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        page: {
            kind: "share",
            code: (application) => `morty_transfer_v1.${application.identity.computerId}.${"a".repeat(43)}`,
        },
    });
    await app.waitForView(() =>
        expect(getByRole(document.body, "alert").textContent).toContain(
            "This link was already used, has expired, or was revoked. Ask for a new link.",
        ),
    );
    expect(getByRole(document.body, "heading", { name: "This link is no longer available" })).toBeDefined();
    expect(document.body.textContent).not.toContain("Next step");
    expect(document.body.textContent).not.toContain("Run setup again");
    expect(queryByRole(document.body, "button", { name: "Copy setup prompt" })).toBeNull();
    expect(queryByRole(document.body, "button", { name: "Try again" })).toBeNull();
});

for (const linkKind of ["handoff", "sharing"] as const) {
    test(`Given a ${linkKind} link and an unavailable connection, When I reconnect and retry, Then Morty checks the link again and explains its terminal failure`, {
        timeout: 30_000,
    }, async () => {
        const code = (application: TestApp["identity"]) =>
            `morty_transfer_v1.${application.computerId}.${"a".repeat(43)}`;
        const app = await createTestApp({
            prepare: ({ transport }) => transport.disconnect(),
            page:
                linkKind === "handoff"
                    ? {
                          kind: "continue",
                          harness: "pi",
                          sessionId: "missing-session",
                          code: (application) => code(application.identity),
                      }
                    : { kind: "share", code: (application) => code(application.identity) },
        });
        const retry = await app.waitForView(() => getByRole(document.body, "button", { name: "Try again" }));
        expect(document.body.textContent).not.toContain("Ask for a new link.");
        expect(document.body.textContent).not.toContain("Run setup again");
        app.transport.open();
        await app.user.click(retry);
        await app.waitForView(() =>
            expect(getByRole(document.body, "alert").textContent).toContain(
                linkKind === "handoff"
                    ? "This link was already used, has expired, or was revoked. Run setup again on that computer."
                    : "This link was already used, has expired, or was revoked. Ask for a new link.",
            ),
        );
        expect(queryByRole(document.body, "button", { name: "Try again" })).toBeNull();
        expect(document.body.textContent).not.toContain("Next step");
    });
}

for (const segments of [0, 4, 8]) {
    test.skipIf(segments === 8 && process.platform !== "linux")(
        `Given a setup handoff carries a ${segments > 0 ? `${segments}-segment multibyte` : "short"} project directory, When the original session is unavailable and I enter Morty, Then the validated directory is selected and remembered`,
        {
            timeout: 30_000,
        },
        async () => {
            const root = await realpath(await mkdtemp(join(tmpdir(), "morty-handoff-project-")));
            const directory = join(
                root,
                ...Array.from({ length: segments }, () => "\u00e9".repeat(segments === 8 ? 110 : 90)),
            );
            try {
                await mkdir(directory, { recursive: true });
                const app = await createTestApp({
                    connectAgent: true,
                    agent: { harness: "codex", label: "Codex" },
                    page: {
                        kind: "continue",
                        harness: "codex",
                        sessionId: "native-project-session",
                        workspace: directory,
                    },
                });
                await app.waitForView(() =>
                    expect(getByRole(document.body, "alert").textContent).toContain("The native session was not found"),
                );
                await app.user.click(getByRole(document.body, "button", { name: "Go to Morty" }));
                const continued = await app.reload();
                await continued.user.click(
                    await continued.waitForView(() => getByRole(document.body, "button", { name: "New Session" })),
                );
                expect((await continued.queryElementByTestId(dataTestId.workingDirectory)).textContent).toContain(
                    directory.split("/").at(-1),
                );
                await continued.user.click(continued.elementByTestId(dataTestId.workingDirectory));
                expect((await continued.queryElementByTestId(dataTestId.recentWorkingDirectory)).textContent).toContain(
                    directory,
                );
                await continued.user.click(continued.elementByTestId(dataTestId.changeWorkingDirectory));
                const path = await continued.queryElementByTestId(dataTestId.workingDirectoryPath);
                if (!(path instanceof HTMLInputElement)) {
                    throw new Error("Expected working directory path input");
                }
                expect(path.value).toBe(directory);
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        },
    );
}

test("Given a handoff requests a missing directory, When it opens, Then the Computer reports the directory failure before continuing the session", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        connectAgent: true,
        agent: { harness: "codex", label: "Codex" },
        sessionIds: new Set(["native-directory-session"]),
        page: {
            kind: "continue",
            harness: "codex",
            sessionId: "native-directory-session",
            workspace: join(tmpdir(), `missing-handoff-directory-${crypto.randomUUID()}`),
        },
    });
    const alert = await app.waitForView(() => getByRole(document.body, "alert"));
    expect(alert.textContent).toContain(
        "does not exist. Choose an existing directory or create it locally before retrying.",
    );
    expect(getByRole(document.body, "button", { name: "Try again" })).toBeInstanceOf(HTMLButtonElement);
    expect(window.location.pathname).toBe("/continue");
});

for (const segment of ["a".repeat(220), "\u00e9".repeat(110)]) {
    test(`Given a handoff path over 1533 UTF-8 bytes with ${segment.charCodeAt(0)} characters, When the directory does not exist, Then the request reaches the Computer's filesystem validation`, {
        timeout: 30_000,
    }, async () => {
        const workspace = join(tmpdir(), `missing-${crypto.randomUUID()}`, ...Array.from({ length: 8 }, () => segment));
        expect(new TextEncoder().encode(workspace).length).toBeGreaterThan(1533);
        const app = await createTestApp({
            connectAgent: true,
            agent: { harness: "codex", label: "Codex" },
            page: { kind: "continue", harness: "codex", sessionId: "native-directory-session", workspace },
        });
        const alert = await app.waitForView(() => getByRole(document.body, "alert"));
        // Filesystems may reject the path length before checking whether its first missing segment exists.
        expect(alert.textContent).toMatch(
            /This directory is missing or unavailable|The selected directory does not exist/u,
        );
    });
}

test("Given other browsers joined this computer, When the user disconnects one from Devices and then all others, Then each loses access while this browser keeps working", {
    timeout: 60_000,
}, async () => {
    // This browser joins through a link, as the owner's phone does; the redeemed link then opens the computer.
    const joined = await createTestApp({ connectAgent: true, page: { kind: "share" } });
    await joined.waitForView(() => expect(new URL(window.location.href).searchParams.get("identity")).not.toBeNull());
    const app = await joined.reload();
    const session = (token: string) =>
        app.transport.request(
            new Request(`${app.origin}/morty/api/v1/computers/${app.identity.computerId}/session`, {
                headers: { authorization: `Bearer ${token}` },
            }),
        );
    const join = async (device: string) => {
        const code = new URL(await app.createTransferUrl()).hash.slice("#code=".length);
        const redeemed = await app.transport.request(
            new Request(`${app.origin}/morty/api/v1/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code, device }),
            }),
        );
        return v.parse(v.object({ computerToken: v.string() }), await redeemed.json()).computerToken;
    };
    const phone = await join("iPhone · Safari");

    await app.user.click(await app.queryElementByTestId(dataTestId.userMenu));
    await app.user.click(getByRole(document.body, "menuitem", { name: "Devices" }));
    const devices = getByRole(document.body, "dialog", { name: "Devices with access" });
    const disconnectPhone = await app.waitForView(() =>
        getByRole(devices, "button", { name: "Disconnect iPhone · Safari" }),
    );
    expect(getByRole(devices, "list", { name: "Devices with access" }).textContent).toContain("This browser");
    await app.user.click(disconnectPhone);
    const disconnectPhoneConfirm = getByRole(document.body, "dialog", { name: "Disconnect iPhone · Safari?" });
    await app.user.click(getByRole(disconnectPhoneConfirm, "button", { name: "Disconnect" }));
    await app.waitForView(() =>
        expect(getByRole(devices, "status").textContent).toContain("iPhone · Safari can no longer use your computer."),
    );
    await app.waitForView(() =>
        expect(queryByRole(devices, "button", { name: "Disconnect iPhone · Safari" })).toBeNull(),
    );
    // The notice and the list show the page's one device list, so the disconnected device leaves both.
    expect(queryByRole(document.body, "status", { name: "New device connected" })).toBeNull();
    expect((await session(phone)).status).toBe(401);

    const laptop = await join("macOS · Chrome");
    await app.waitForView(() => getByRole(devices, "button", { name: "Disconnect macOS · Chrome" }));
    await app.user.click(getByRole(devices, "button", { name: "Disconnect all" }));
    const disconnectAll = getByRole(document.body, "dialog", { name: "Disconnect every other device?" });
    await app.user.click(getByRole(disconnectAll, "button", { name: "Disconnect" }));
    await app.waitForView(() =>
        expect(getByRole(devices, "status").textContent).toContain("Other devices can no longer use your computer"),
    );
    expect((await session(laptop)).status).toBe(401);
    await app.user.click(getByRole(devices, "button", { name: "Close dialog" }));

    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Still connected here");
    await app.waitForView(
        () =>
            expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
                "Codex turn 1: Still connected here",
            ),
        30_000,
    );
});

test("Given a browser that acknowledged a new device, When another device joins through a link, Then a new notice appears without reloading or leaving the page", {
    timeout: 60_000,
}, async () => {
    const joined = await createTestApp({ connectAgent: true, page: { kind: "share" } });
    await joined.waitForView(() => expect(new URL(window.location.href).searchParams.get("identity")).not.toBeNull());
    const join = async (page: typeof joined, device: string) => {
        const code = new URL(await page.createTransferUrl()).hash.slice("#code=".length);
        const redeemed = await page.transport.request(
            new Request(`${page.origin}/morty/api/v1/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code, device }),
            }),
        );
        expect(redeemed.status).toBe(200);
    };
    // This browser looked at its devices before, when there were none; a device joined since.
    centralLocalStorage.write(linkedDevicesSeenEntry(joined.identity.computerId), new Date(0).toISOString());
    await join(joined, "iPhone · Safari");
    const app = await joined.reload();
    const first = await app.waitForView(() => getByRole(document.body, "status", { name: "New device connected" }));
    expect(first.textContent).toContain("iPhone · Safari");
    await app.user.click(getByRole(first, "button", { name: "Got it" }));
    expect(queryByRole(document.body, "status", { name: "New device connected" })).toBeNull();

    await join(app, "Mac · Edge");

    const next = await app.waitForView(
        () => getByRole(document.body, "status", { name: "New device connected" }),
        30_000,
    );
    expect(next.textContent).toContain("Mac · Edge");
    expect(next.textContent).not.toContain("iPhone · Safari");
});

test("Given a new device and this browser's access in the sidebar, When the user swipes the notices, Then the other notice is shown and swiping back returns", {
    timeout: 60_000,
}, async () => {
    const joined = await createTestApp({ connectAgent: true, page: { kind: "share" } });
    await joined.waitForView(() => expect(new URL(window.location.href).searchParams.get("identity")).not.toBeNull());
    const code = new URL(await joined.createTransferUrl()).hash.slice("#code=".length);
    const redeemed = await joined.transport.request(
        new Request(`${joined.origin}/morty/api/v1/identity/transfers/redeem`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code, device: "iPhone · Safari" }),
        }),
    );
    expect(redeemed.status).toBe(200);
    centralLocalStorage.write(linkedDevicesSeenEntry(joined.identity.computerId), new Date(0).toISOString());
    const app = await joined.reload();
    const carousel = await app.waitForView(() => {
        const region = getByRole(document.body, "region", { name: "Access notices" });
        expect(getByRole(region, "status", { name: "New device connected" }).textContent).toContain("iPhone · Safari");
        expect(queryByRole(region, "status", { name: "This browser's access" })).toBeNull();
        return region;
    });
    await app.user.hover(carousel);
    await app.user.pointer([
        { keys: "[TouchA>]", target: carousel, coords: { x: 220, y: 40 } },
        { pointerName: "TouchA", target: carousel, coords: { x: 40, y: 40 } },
        { keys: "[/TouchA]", target: carousel, coords: { x: 40, y: 40 } },
    ]);
    await app.waitForView(() => {
        expect(getByRole(carousel, "status", { name: "This browser's access" })).toBeInstanceOf(HTMLElement);
        expect(queryByRole(carousel, "status", { name: "New device connected" })).toBeNull();
    });
    await app.user.pointer([
        { keys: "[MouseLeft>]", target: carousel, coords: { x: 40, y: 40 } },
        { coords: { x: 220, y: 40 }, target: carousel },
        { keys: "[/MouseLeft]", target: carousel, coords: { x: 220, y: 40 } },
    ]);
    await app.waitForView(() => {
        expect(getByRole(carousel, "status", { name: "New device connected" }).textContent).toContain(
            "iPhone · Safari",
        );
        expect(queryByRole(carousel, "status", { name: "This browser's access" })).toBeNull();
    });
});

test("Given this browser already dismissed its access notice, When a new device joins, Then the sidebar shows that card without a blank carousel page", {
    timeout: 60_000,
}, async () => {
    const joined = await createTestApp({ connectAgent: true, page: { kind: "share" } });
    await joined.waitForView(() => expect(new URL(window.location.href).searchParams.get("identity")).not.toBeNull());
    const app = await joined.reload();
    const access = await app.waitForView(() => getByRole(document.body, "status", { name: "This browser's access" }));
    await app.user.click(getByRole(access, "button", { name: "Got it" }));
    expect(queryByRole(document.body, "status", { name: "This browser's access" })).toBeNull();

    centralLocalStorage.write(linkedDevicesSeenEntry(joined.identity.computerId), new Date(0).toISOString());
    const code = new URL(await app.createTransferUrl()).hash.slice("#code=".length);
    const redeemed = await app.transport.request(
        new Request(`${app.origin}/morty/api/v1/identity/transfers/redeem`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code, device: "iPhone · Safari" }),
        }),
    );
    expect(redeemed.status).toBe(200);
    const reloaded = await app.reload();
    const device = await reloaded.waitForView(() =>
        getByRole(document.body, "status", { name: "New device connected" }),
    );
    expect(device.textContent).toContain("iPhone · Safari");
    expect(queryByRole(document.body, "region", { name: "Access notices" })).toBeNull();
    expect(queryByRole(document.body, "button", { name: "Notice 2 of 2" })).toBeNull();
    expect(queryByRole(document.body, "status", { name: "This browser's access" })).toBeNull();
});

test("Given a browser whose access ends within the hour, When the page stays open, Then it is reminded once, not told it joined again, and the account menu states the term", {
    timeout: 60_000,
}, async () => {
    // The Worker grants the device term from its own clock, so the page's clock starts at that same moment.
    const clock = new TestClock(new Date().toISOString());
    const joined = await createTestApp({ connectAgent: true, page: { kind: "share" }, clock });
    await joined.waitForView(() => expect(new URL(window.location.href).searchParams.get("identity")).not.toBeNull());
    const app = await joined.reload();
    const accountMenu = async (page: typeof app) => {
        await page.user.click(await page.queryElementByTestId(dataTestId.userMenu));
        const menu = await page.waitForView(() => {
            const shown = getByRole(document.body, "menu");
            expect(shown.textContent).toContain("Access in this browser");
            return shown;
        });
        await page.user.keyboard("{Escape}");
        return menu.textContent;
    };
    expect(await accountMenu(app)).toContain("Until ");
    expect(queryByRole(document.body, "status", { name: "Access ending soon" })).toBeNull();

    clock.advanceBy(23 * 60 * 60 * 1000 + 60_000);
    const reminder = await app.waitForView(() => getByRole(document.body, "status", { name: "Access ending soon" }));
    expect(reminder.textContent).toContain("Access in this browser ends");
    expect(reminder.textContent).toContain("open a new link from your computer or another device");
    await app.user.click(getByRole(reminder, "button", { name: "Got it" }));
    expect(queryByRole(document.body, "status", { name: "Access ending soon" })).toBeNull();

    // The reminder covers the joined notice this browser never dismissed.
    const reloaded = await app.reload();
    await accountMenu(reloaded);
    expect(queryByRole(document.body, "status", { name: "Access ending soon" })).toBeNull();
    expect(queryByRole(document.body, "status", { name: "This browser's access" })).toBeNull();
});

test("Given a browser that just joined through a link, When its page opens, Then it is told once until when it can use the computer and where to manage devices", {
    timeout: 60_000,
}, async () => {
    const joined = await createTestApp({ connectAgent: true, page: { kind: "share" } });
    await joined.waitForView(() => expect(new URL(window.location.href).searchParams.get("identity")).not.toBeNull());
    const app = await joined.reload();
    const notice = await app.waitForView(() => getByRole(document.body, "status", { name: "This browser's access" }));
    expect(notice.textContent).toContain("This browser can use");
    expect(notice.textContent).toContain(" until ");
    expect(getByRole(notice, "button", { name: "Devices" })).toBeInstanceOf(HTMLButtonElement);
    await app.user.click(getByRole(notice, "button", { name: "Got it" }));
    expect(queryByRole(document.body, "status", { name: "This browser's access" })).toBeNull();

    const reloaded = await app.reload();
    await reloaded.user.click(await reloaded.queryElementByTestId(dataTestId.userMenu));
    await reloaded.waitForView(() =>
        expect(getByRole(document.body, "menu").textContent).toContain("Access in this browser"),
    );
    expect(queryByRole(document.body, "status", { name: "This browser's access" })).toBeNull();
});
