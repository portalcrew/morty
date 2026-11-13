import { tmpdir } from "node:os";
import { getAllByRole, getByRole, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { ANONYMOUS_CREDENTIAL_KEY_NAME } from "../src/services/identity/anonymous-identity-api.ts";
import { encodeIdentityScope } from "../src/services/identity/identity-scope-url.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";
import { TestApiTransport } from "./support/test-api-transport.ts";

async function startConversation(app: TestApp, prompt: string): Promise<string> {
    const composer = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, prompt);
    await app.waitForView(() =>
        expect(
            app.elementsByTestId(dataTestId.agentResponse).some((entry) => entry.textContent?.includes(prompt)),
        ).toBe(true),
    );
    const sessionId = new URL(window.location.href).searchParams.get("sessionId");
    if (sessionId === null) {
        throw new Error("The opened conversation must have an address");
    }
    return sessionId;
}

function computerChoices(menu: HTMLElement): HTMLElement[] {
    return getAllByRole(menu, "menuitemradio");
}

/** Other computers are links to their address; the current computer is not a link because it is already open. */
function identityOf(choice: HTMLElement, currentScope: string): string | null {
    return choice instanceof HTMLAnchorElement
        ? new URL(choice.href, window.location.origin).searchParams.get("identity")
        : currentScope;
}

test("Given two remembered computers, When I return and then switch, Then the last computer and each computer's own conversation are restored", {
    timeout: 30_000,
}, async () => {
    const first = await createTestApp({ connectAgent: true });
    const firstSession = await startConversation(first, "Work on computer A");
    const firstScope = encodeIdentityScope({
        computerId: first.identity.computerId,
    });
    await first.close();
    const second = await createTestApp({ connectAgent: true });
    const secondSession = await startConversation(second, "Work on computer B");
    const secondScope = encodeIdentityScope({
        computerId: second.identity.computerId,
    });
    window.location.href = `${second.origin}/chat`;
    const returned = await second.reload();
    await returned.waitForView(() =>
        expect(new URL(window.location.href).searchParams.get("sessionId")).toBe(secondSession),
    );
    const switcher = await returned.waitForView(() => getByRole(document.body, "button", { name: /Switch computer/ }));
    await returned.user.click(switcher);
    const { choices, details } = await returned.waitForView(() => {
        const menu = getByRole(document.body, "menu");
        const items = computerChoices(menu);
        if (items.length !== 2) {
            throw new Error("Waiting for both computers");
        }
        return { choices: items, details: getByRole(menu, "menuitem", { name: /View execution details/ }) };
    });
    expect(queryByRole(document.body, "group", { name: "Current computer" })).toBeNull();
    expect(queryByRole(document.body, "group", { name: "Other computers" })).toBeNull();
    expect(choices.filter((item) => item.getAttribute("aria-checked") === "true")).toHaveLength(1);
    const [firstChoice] = choices;
    if (firstChoice === undefined) {
        throw new Error("Expected a computer");
    }
    expect(details.compareDocumentPosition(firstChoice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const order = choices.map((item) => identityOf(item, secondScope));
    expect(choices.find((item) => item.getAttribute("aria-checked") === "true")).not.toBeInstanceOf(HTMLAnchorElement);
    const firstLink = choices.find((item) => identityOf(item, secondScope) === firstScope);
    if (!(firstLink instanceof HTMLAnchorElement)) {
        throw new Error("Expected computer A");
    }
    expect(firstLink.getAttribute("aria-checked")).toBe("false");
    expect(new URL(firstLink.href).searchParams.get("sessionId")).toBe(firstSession);
    // A folder belongs to one Session, not to the computer, so the computer list never shows it.
    expect(firstLink.textContent).not.toContain("workspace");
    expect(firstLink.querySelector(".sr-only")?.textContent).toBe("Online");
    window.location.href = firstLink.href;
    const switched = await returned.reload();
    await switched.waitForView(() =>
        expect(
            switched
                .elementsByTestId(dataTestId.agentResponse)
                .some((item) => item.textContent?.includes("Work on computer A")),
        ).toBe(true),
    );
    expect(new URL(window.location.href).searchParams.get("identity")).toBe(firstScope);
    await switched.user.click(
        await switched.waitForView(() => getByRole(document.body, "button", { name: /Switch computer/ })),
    );
    const reordered = await switched.waitForView(() => {
        const items = computerChoices(getByRole(document.body, "menu"));
        if (items.length !== 2) {
            throw new Error("Waiting for both computers");
        }
        return items;
    });
    expect(reordered.map((item) => identityOf(item, firstScope))).toEqual(order);
    expect(reordered.findIndex((item) => item.getAttribute("aria-checked") === "true")).toBe(order.indexOf(firstScope));
});

test("Given two remembered computers, When I choose the computer I am already on, Then the menu closes and the conversation stays open", {
    timeout: 30_000,
}, async () => {
    const first = await createTestApp({ connectAgent: true });
    await startConversation(first, "Another computer");
    await first.close();
    const app = await createTestApp({ connectAgent: true });
    const sessionId = await startConversation(app, "Stay on this computer");
    await app.user.click(await app.waitForView(() => getByRole(document.body, "button", { name: /Switch computer/ })));
    const current = await app.waitForView(() => {
        const choice = computerChoices(getByRole(document.body, "menu")).find(
            (item) => item.getAttribute("aria-checked") === "true",
        );
        if (choice === undefined) {
            throw new Error("Waiting for the current computer");
        }
        return choice;
    });
    const address = window.location.href;
    await app.user.click(current);
    await app.waitForView(() => expect(queryByRole(document.body, "menu")).toBeNull());
    expect(window.location.href).toBe(address);
    expect(new URL(window.location.href).searchParams.get("sessionId")).toBe(sessionId);
    expect(
        app
            .elementsByTestId(dataTestId.agentResponse)
            .some((item) => item.textContent?.includes("Stay on this computer")),
    ).toBe(true);
});

test("Given two remembered computers on mobile, When I open navigation and tap the current computer, Then navigation closes and execution details stay one tap away", {
    timeout: 30_000,
}, async () => {
    const desktopViewport = { height: window.innerHeight, width: window.innerWidth };
    let first: TestApp | null = null;
    let current: TestApp | null = null;
    try {
        first = await createTestApp({ connectAgent: true });
        await startConversation(first, "Other mobile computer");
        await first.close();
        first = null;

        window.happyDOM.setViewport({ height: 844, width: 413 });
        current = await createTestApp({ connectAgent: true });
        const sessionId = await startConversation(current, "Current mobile computer");
        const app = current;
        const openNavigation = async () => {
            await app.user.click(getByRole(document.body, "button", { name: "Open navigation" }));
            return app.waitForView(() => {
                const computers = getByRole(document.body, "navigation", { name: "Computers" });
                const others = getAllByRole(computers, "link").filter((item) => item.getAttribute("href") !== "/setup");
                const current = computers.querySelectorAll('[aria-current="true"]');
                const [choice] = current;
                if (others.length !== 1 || current.length !== 1 || !(choice instanceof HTMLElement)) {
                    throw new Error("Waiting for both computers");
                }
                return { computers, current: choice };
            });
        };
        const { computers, current: currentChoice } = await openNavigation();
        expect(queryByRole(computers, "region", { name: "Current computer" })).toBeNull();
        expect(queryByRole(computers, "region", { name: "Other computers" })).toBeNull();
        expect(currentChoice).toBeInstanceOf(HTMLButtonElement);
        expect(getAllByRole(computers, "button", { name: /View execution details/ })).toHaveLength(1);
        const address = window.location.href;
        await app.user.click(currentChoice);
        await app.waitForView(() =>
            expect(getByRole(document.body, "button", { name: "Open navigation" }).getAttribute("aria-expanded")).toBe(
                "false",
            ),
        );
        expect(window.location.href).toBe(address);
        expect(new URL(window.location.href).searchParams.get("sessionId")).toBe(sessionId);
        const reopened = await openNavigation();
        await app.user.click(getByRole(reopened.computers, "button", { name: /View execution details/ }));
        await app.waitForView(() => getByRole(document.body, "dialog", { name: "Execution details" }));
    } finally {
        if (first !== null) {
            await first.close();
        }
        if (current !== null) {
            await current.close();
        }
        window.happyDOM.setViewport(desktopViewport);
    }
});

test("Given a remembered computer, When I deliberately start a new conversation then return, Then its chat home stays selected", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await startConversation(app, "An earlier conversation");
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    window.location.href = `${app.origin}/`;
    const returned = await app.reload();
    await returned.waitForView(() => getByRole(document.body, "textbox", { name: "Message" }));
    expect(new URL(window.location.href).searchParams.has("sessionId")).toBe(false);
    expect(returned.elementsByTestId(dataTestId.agentResponse)).toHaveLength(0);
});

test("Given a browser without saved access, When I open a copied computer address, Then Morty explains that this browser is not paired and offers a link home", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(dataTestId.messageComposer);
    const address = window.location.href;
    // The other browser has the address, but none of this browser's saved access.
    window.localStorage.clear();
    window.sessionStorage.clear();
    const unpaired = await app.reload();
    await unpaired.waitForView(() => getByRole(document.body, "heading", { name: "Browser not paired" }));
    expect(document.body.textContent).toContain("Copied browser URLs don’t grant access.");
    expect(document.body.textContent).not.toContain("Pair again with this computer.");
    expect(document.body.textContent).toContain("Open your agent’s link or scan its QR code.");
    expect(queryByRole(document.body, "button", { name: "Copy setup prompt" })).toBeNull();
    expect(getByRole(document.body, "link", { name: "Go to morty" }).getAttribute("href")).toBe("/");
    expect(window.location.href).toBe(address);
    expect(queryByRole(document.body, "textbox", { name: "Message" })).toBeNull();
});

test("Given a remembered computer, When I open an invalid explicit computer link, Then it never switches me to the remembered computer automatically", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await startConversation(app, "Stay on the intended computer");
    window.location.href = `${app.origin}/chat?identity=invalid`;
    const invalid = await app.reload();
    await invalid.waitForView(() => getByRole(document.body, "heading", { name: "This link is no longer valid" }));
    expect(queryByRole(document.body, "textbox", { name: "Message" })).toBeNull();
    expect(getByRole(document.body, "link", { name: "Back to your last computer" }).getAttribute("href")).toBe("/");
    expect(new URL(window.location.href).searchParams.get("identity")).toBe("invalid");
});

test.each(["/setup", "/setup/"])(
    "Given a remembered computer and its identity-scoped %s URL, When I open setup, Then I can copy the setup prompt and return to my original conversation",
    {
        timeout: 30_000,
    },
    async (path) => {
        const app = await createTestApp({ connectAgent: true });
        const sessionId = await startConversation(app, "Return after scoped setup");
        const setupUrl = new URL(window.location.href);
        setupUrl.pathname = path;
        setupUrl.searchParams.delete("sessionId");
        window.location.href = setupUrl.href;
        const setup = await app.reload();
        await setup.waitForView(() => getByRole(document.body, "heading", { name: "Connect another computer" }));
        await setup.user.click(getByRole(document.body, "button", { name: "Copy setup prompt" }));
        expect(await navigator.clipboard.readText()).toContain(`${app.origin}/doc/setup.md`);
        const back = getByRole(document.body, "link", { name: "Back to your last computer" });
        window.location.href = new URL(back.getAttribute("href") ?? "", app.origin).href;
        const returned = await setup.reload();
        await returned.waitForView(() =>
            expect(new URL(window.location.href).searchParams.get("sessionId")).toBe(sessionId),
        );
    },
);

test("Given a remembered computer, When I connect another computer, Then setup remains reachable and returning keeps my original conversation", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const sessionId = await startConversation(app, "Keep this computer available");
    await app.user.click(await app.waitForView(() => getByRole(document.body, "button", { name: /Switch computer/ })));
    const setup = getByRole(document.body, "menuitem", { name: "Connect another computer" });
    expect(setup.getAttribute("href")).toBe("/setup");
    window.location.href = `${app.origin}/setup`;
    const instruction = await app.reload();
    await instruction.waitForView(() => getByRole(document.body, "heading", { name: "Connect another computer" }));
    expect(getByRole(document.body, "link", { name: "Back to your last computer" }).getAttribute("href")).toBe("/");
    window.location.href = `${app.origin}/`;
    const returned = await instruction.reload();
    await returned.waitForView(() =>
        expect(new URL(window.location.href).searchParams.get("sessionId")).toBe(sessionId),
    );
});

async function revokeAccess(app: TestApp): Promise<void> {
    const signal = AbortSignal.timeout(10_000);
    const response = await app.transport.request(
        new Request(`${app.origin}/morty/api/v1/computers/${app.identity.computerId}/identity/local-credential`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${await app.identity.getToken(signal)}` },
            signal,
        }),
    );
    expect(response.status).toBe(204);
}

test("Given the last computer's access ended, When I return through the plain address, Then the next valid computer opens", {
    timeout: 30_000,
}, async () => {
    const first = await createTestApp({ connectAgent: true });
    const firstSession = await startConversation(first, "The remaining computer");
    await first.close();
    const second = await createTestApp({ connectAgent: true });
    await startConversation(second, "The revoked computer");
    await revokeAccess(second);
    window.location.href = `${second.origin}/`;
    const returned = await second.reload();
    await returned.waitForView(() =>
        expect(new URL(window.location.href).searchParams.get("sessionId")).toBe(firstSession),
    );
    await returned.waitForView(() =>
        expect(
            returned
                .elementsByTestId(dataTestId.agentResponse)
                .some((item) => item.textContent?.includes("The remaining computer")),
        ).toBe(true),
    );
    expect(document.body.textContent).toContain("Access to Controlled Agent Runtime ended");
});

test("Given a revoked explicit computer link and another saved computer, When I open the link, Then only a deliberate fallback is offered", {
    timeout: 30_000,
}, async () => {
    const first = await createTestApp({ connectAgent: true });
    await startConversation(first, "Another valid computer");
    await first.close();
    const second = await createTestApp({ connectAgent: true });
    await startConversation(second, "Explicit revoked computer");
    await revokeAccess(second);
    const returned = await second.reload();
    await returned.waitForView(() =>
        expect(getByRole(document.body, "status").textContent).toContain("Current access ended"),
    );
    expect(getByRole(document.body, "link", { name: "Back to your last computer" })).toBeInstanceOf(HTMLAnchorElement);
    expect(queryByRole(document.body, "textbox", { name: "Message" })).toBeNull();
});

test("Given an open conversation, When its access is revoked elsewhere and I start a new conversation, Then Morty explains that the current access ended", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await startConversation(app, "Before revocation");
    await revokeAccess(app);

    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));

    await app.waitForView(() =>
        expect(getByRole(document.body, "status").textContent).toContain("Current access ended"),
    );
    expect(document.body.textContent).toContain("Your local agent and tasks keep running");
    expect(document.body.textContent).not.toMatch(/sign in|something went wrong/iu);
    expect(queryByRole(document.body, "textbox", { name: "Message" })).toBeNull();
    expect(new URL(window.location.href).searchParams.has("identity")).toBe(false);
});

test("Given an open conversation, When another tab removes this browser's access, Then Morty explains that the current access ended", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await startConversation(app, "Before another tab ended access");

    // Another tab ended the access every tab of this browser shares.
    window.localStorage.removeItem(ANONYMOUS_CREDENTIAL_KEY_NAME);
    window.dispatchEvent(new StorageEvent("storage", { key: ANONYMOUS_CREDENTIAL_KEY_NAME }));

    await app.waitForView(() =>
        expect(getByRole(document.body, "status").textContent).toContain("Current access ended"),
    );
    expect(queryByRole(document.body, "heading", { name: "Browser not paired" })).toBeNull();
    expect(queryByRole(document.body, "textbox", { name: "Message" })).toBeNull();
    expect(new URL(window.location.href).searchParams.has("identity")).toBe(false);
});

test("Given the last computer is offline and another is online, When I return, Then I stay on the offline computer and can explicitly switch", {
    timeout: 30_000,
}, async () => {
    const first = await createTestApp({ connectAgent: true });
    const firstSession = await startConversation(first, "Online computer");
    await first.close();
    const second = await createTestApp({ connectAgent: true });
    const secondSession = await startConversation(second, "Offline computer");
    if (second.daemon === null) {
        throw new Error("Expected a daemon");
    }
    await second.daemon.disconnect();
    window.location.href = `${second.origin}/`;
    const returned = await second.reload();
    await returned.user.click(
        await returned.waitForView(() => getByRole(document.body, "button", { name: /Switch computer/ })),
    );
    const offlineChoice = await returned.waitForView(() => {
        const choice = computerChoices(getByRole(document.body, "menu")).find(
            (item) => item.getAttribute("aria-checked") === "true",
        );
        if (choice === undefined || !choice.textContent?.includes("Offline")) {
            throw new Error("Waiting for the current computer");
        }
        return choice;
    });
    expect(offlineChoice.textContent).toContain("Offline");
    const alternative = await returned.waitForView(() => {
        const choice = getAllByRole(document.body, "menuitemradio").find(
            (item) =>
                new URL(item.getAttribute("href") ?? "/", returned.origin).searchParams.get("sessionId") ===
                firstSession,
        );
        if (!(choice instanceof HTMLAnchorElement)) {
            throw new Error("Waiting for the other computer");
        }
        expect(choice.textContent).toContain("Online");
        return choice;
    });
    expect(new URL(window.location.href).searchParams.get("sessionId")).toBe(secondSession);
    expect(new URL(alternative.getAttribute("href") ?? "", returned.origin).searchParams.get("sessionId")).toBe(
        firstSession,
    );
    expect(returned.elementByTestId(dataTestId.botConnectionStatus).getAttribute("data-connection-status")).toBe(
        "disconnected",
    );
});

test("Given a saved computer and a failed connection, When I retry after reconnecting, Then my original conversation is retained", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const sessionId = await startConversation(app, "Preserve access through a network failure");
    await app.close();
    window.location.href = `${app.origin}/`;
    // A reload gets its own page transport; the previous one was disposed.
    const transport = new TestApiTransport(app.origin);
    transport.disconnect();
    const unavailable = await createTestApp({
        application: { ...app, transport, close: () => transport.dispose() },
        page: { kind: "reload" },
    });
    const retry = await unavailable.waitForView(() => getByRole(document.body, "button", { name: "Retry" }));
    expect(document.body.textContent).toContain("Your saved computers are still here");
    unavailable.transport.open();
    await unavailable.user.click(retry);
    await unavailable.waitForView(() =>
        expect(new URL(window.location.href).searchParams.get("sessionId")).toBe(sessionId),
    );
    await unavailable.waitForView(() => getByRole(document.body, "textbox", { name: "Message" }));
});

test("Given two computers, When I end the current access, Then the other computer opens with its own route and a named confirmation", {
    timeout: 30_000,
}, async () => {
    const first = await createTestApp({ connectAgent: true });
    const firstSession = await startConversation(first, "Surviving computer conversation");
    await first.close();
    const second = await createTestApp({ connectAgent: true });
    await startConversation(second, "Computer to disconnect");
    await second.user.type(
        getByRole(document.body, "textbox", { name: "Message" }),
        "Do not send this draft to the other computer",
    );
    await second.user.click(await second.queryElementByTestId(dataTestId.userMenu));
    await second.user.click(await second.queryElementByTestId(dataTestId.endRemoteAccess));
    const dialog = await second.queryElementByTestId(dataTestId.endRemoteAccessDialog);
    const confirm = await second.waitForView(() => {
        const button = getByRole(dialog, "button", { name: "End current access" });
        expect(button.hasAttribute("disabled")).toBe(false);
        return button;
    });
    await second.user.click(confirm);
    await second.waitForView(() => expect(new URL(window.location.href).searchParams.has("identity")).toBe(false));
    expect(new URL(window.location.href).searchParams.has("sessionId")).toBe(false);
    const returned = await second.reload();
    await returned.waitForView(() =>
        expect(new URL(window.location.href).searchParams.get("sessionId")).toBe(firstSession),
    );
    await returned.waitForView(() =>
        expect(document.body.textContent).toContain("Access to Controlled Agent Runtime ended"),
    );
    const composer = await returned.waitForView(() => getByRole(document.body, "textbox", { name: "Message" }));
    expect(composer).toHaveProperty("value", "");
});

test("Given saved access for the same computer, When an old native handoff link has expired without an identity query, Then that access still opens the intended target", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ agent: { harness: "pi", label: "Pi" }, connectAgent: true });
    await startConversation(app, "Keep the issued grant");
    window.location.href = `${app.origin}/continue?harness=pi&sessionId=missing-session&workspace=${encodeURIComponent(tmpdir())}#code=morty_transfer_v1.${app.identity.computerId}.${"a".repeat(43)}`;
    const continued = await app.reload();
    await continued.waitForView(() =>
        expect(getByRole(document.body, "alert").textContent).toContain("The native session was not found"),
    );
    expect(getByRole(document.body, "button", { name: "Go to Morty" })).toBeInstanceOf(HTMLButtonElement);
});

test("Given another saved computer, When a transfer link cannot be redeemed, Then the page offers a secondary explicit fallback without switching", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await startConversation(app, "Do not replace the explicit target");
    await app.close();
    const other = await createTestApp({
        page: {
            kind: "continue",
            harness: "pi",
            sessionId: "missing-session",
            code: (application) => `morty_transfer_v1.${application.identity.computerId}.${"a".repeat(43)}`,
        },
    });
    await other.waitForView(() =>
        expect(getByRole(document.body, "alert").textContent).toContain(
            "This link was already used, has expired, or was revoked. Run setup again on that computer.",
        ),
    );
    expect(getByRole(document.body, "link", { name: "Back to your last computer" })).toBeInstanceOf(HTMLAnchorElement);
    expect(queryByRole(document.body, "button", { name: "Try again" })).toBeNull();
    expect(document.body.textContent).toContain("Run setup again on that computer.");
    expect(window.location.pathname).toBe("/continue");
    expect(queryByRole(document.body, "button", { name: "Go to Morty" })).toBeNull();
});

test("Given the remembered conversation was closed elsewhere, When I return, Then the same computer opens at chat home while an explicit stale conversation link still reports failure", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const sessionId = await startConversation(app, "Conversation closed on another device");
    const explicit = window.location.href;
    const signal = AbortSignal.timeout(10_000);
    const archived = await app.transport.request(
        new Request(`${app.origin}/morty/api/v1/computers/${app.identity.computerId}/managed-sessions/archive`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${await app.identity.getToken(signal)}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({
                harness: new URL(explicit).searchParams.get("harness"),
                sessionId: sessionId,
            }),
            signal,
        }),
    );
    expect(archived.status).toBe(200);
    window.location.href = `${app.origin}/`;
    const restored = await app.reload();
    await restored.waitForView(() => getByRole(document.body, "textbox", { name: "Message" }));
    await restored.waitForView(() => expect(new URL(window.location.href).searchParams.has("sessionId")).toBe(false));
    expect(new URL(window.location.href).searchParams.get("identity")).toBe(
        new URL(explicit).searchParams.get("identity"),
    );
    window.location.href = explicit;
    const linked = await restored.reload();
    await linked.waitForView(() => {
        expect(document.body.textContent).toContain("This session is not in Morty Recent sessions");
        expect(document.body.textContent).toContain(
            'If you closed it in Morty, use "Open Session" to import or fork it again.',
        );
    });
    expect(new URL(window.location.href).searchParams.get("sessionId")).toBe(sessionId);
});

test("Given a computer I keep using, When ten more computers are saved in this browser, Then its link still opens and older unused computers make room", {
    timeout: 120_000,
}, async () => {
    const daily = await createTestApp({ connectAgent: true });
    const dailySession = await startConversation(daily, "My daily computer");
    const dailyLink = window.location.href;
    const dailyScope = new URL(dailyLink).searchParams.get("identity");
    await daily.close();
    const openShared = async (): Promise<TestApp> => {
        const shared = await createTestApp({ page: { kind: "share" } });
        const scope = encodeIdentityScope({
            computerId: shared.identity.computerId,
        });
        await shared.waitForView(() => expect(new URL(window.location.href).searchParams.get("identity")).toBe(scope));
        // The redeemed link replaces the page, which then opens that computer and asks to connect its agent.
        const opened = await shared.reload();
        await opened.waitForView(() => getByRole(document.body, "dialog", { name: "Connect agent" }));
        return opened;
    };
    const openDaily = async (app: TestApp): Promise<TestApp> => {
        window.location.href = dailyLink;
        const opened = await app.reload();
        await opened.waitForView(() => getByRole(document.body, "button", { name: /Switch computer/ }));
        expect(new URL(window.location.href).searchParams.get("sessionId")).toBe(dailySession);
        return opened;
    };

    // The browser fills up with computers, and the daily one is used again before the last is saved.
    let shared = await openShared();
    const oldestScope = new URL(window.location.href).searchParams.get("identity");
    for (let saved = 1; saved < 9; saved += 1) {
        await shared.close();
        shared = await openShared();
    }
    await (await openDaily(shared)).close();
    shared = await openShared();

    // The daily computer is the most recently used of the computers before the last, so it keeps its access.
    const returned = await openDaily(shared);
    await returned.user.click(
        await returned.waitForView(() => getByRole(document.body, "button", { name: /Switch computer/ })),
    );
    await returned.waitForView(() => expect(document.body.textContent).not.toContain("Checking connections"));
    if (dailyScope === null) {
        throw new Error("Expected the daily computer's address");
    }
    const offered = computerChoices(getByRole(document.body, "menu")).map((item) => identityOf(item, dailyScope));
    expect(offered).toContain(dailyScope);
    expect(offered).not.toContain(oldestScope);
    expect(offered.filter((scope) => scope !== null)).toHaveLength(10);
});

test("Given a computer whose remembered conversation was closed elsewhere, When I switch to it from another computer, Then it opens at its chat home", {
    timeout: 30_000,
}, async () => {
    const first = await createTestApp({ connectAgent: true });
    const closedSession = await startConversation(first, "Closed on another device");
    const firstScope = encodeIdentityScope({
        computerId: first.identity.computerId,
    });
    const signal = AbortSignal.timeout(10_000);
    const archived = await first.transport.request(
        new Request(`${first.origin}/morty/api/v1/computers/${first.identity.computerId}/managed-sessions/archive`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${await first.identity.getToken(signal)}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({ harness: "claude", sessionId: closedSession }),
            signal,
        }),
    );
    expect(archived.status).toBe(200);
    await first.close();
    const second = await createTestApp({ connectAgent: true });
    await startConversation(second, "Work on the other computer");

    await second.user.click(
        await second.waitForView(() => getByRole(document.body, "button", { name: /Switch computer/ })),
    );
    const firstLink = await second.waitForView(() => {
        const item = getAllByRole(document.body, "menuitemradio").find(
            (item) =>
                new URL(item.getAttribute("href") ?? "/", second.origin).searchParams.get("identity") === firstScope,
        );
        if (!(item instanceof HTMLAnchorElement)) {
            throw new Error("Waiting for the first computer");
        }
        return item;
    });
    window.location.href = firstLink.href;
    const switched = await second.reload();
    await switched.waitForView(() => getByRole(document.body, "textbox", { name: "Message" }));
    await switched.waitForView(() => expect(new URL(window.location.href).searchParams.has("sessionId")).toBe(false));
    expect(new URL(window.location.href).searchParams.get("identity")).toBe(firstScope);
    expect(document.body.textContent).not.toContain("This session is not in Morty Recent sessions");
});

test("Given a switch to a computer whose remembered conversation is gone, When opening the computer fails once and I retry, Then it still opens at its chat home", {
    timeout: 30_000,
}, async () => {
    const first = await createTestApp({ connectAgent: true });
    const closedSession = await startConversation(first, "Closed before a failed switch");
    const signal = AbortSignal.timeout(10_000);
    const archived = await first.transport.request(
        new Request(`${first.origin}/morty/api/v1/computers/${first.identity.computerId}/managed-sessions/archive`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${await first.identity.getToken(signal)}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({ harness: "claude", sessionId: closedSession }),
            signal,
        }),
    );
    expect(archived.status).toBe(200);
    await first.close();
    const second = await createTestApp({ connectAgent: true });
    await startConversation(second, "Work before the failed switch");
    await second.user.click(
        await second.waitForView(() => getByRole(document.body, "button", { name: /Switch computer/ })),
    );
    const firstScope = encodeIdentityScope({
        computerId: first.identity.computerId,
    });
    const firstLink = await second.waitForView(() => {
        const item = getAllByRole(document.body, "menuitemradio").find(
            (item) =>
                new URL(item.getAttribute("href") ?? "/", second.origin).searchParams.get("identity") === firstScope,
        );
        if (!(item instanceof HTMLAnchorElement)) {
            throw new Error("Waiting for the first computer");
        }
        return item;
    });
    await second.close();

    // The switched-to page loses its connection while it opens the computer.
    window.location.href = firstLink.href;
    const transport = new TestApiTransport(second.origin);
    transport.disconnect();
    const unavailable = await createTestApp({
        application: { ...second, transport, close: () => transport.dispose() },
        page: { kind: "reload" },
    });
    const retry = await unavailable.waitForView(() => getByRole(document.body, "button", { name: "Retry" }));
    unavailable.transport.open();
    await unavailable.user.click(retry);

    await unavailable.waitForView(() => getByRole(document.body, "textbox", { name: "Message" }));
    await unavailable.waitForView(() =>
        expect(new URL(window.location.href).searchParams.has("sessionId")).toBe(false),
    );
    expect(new URL(window.location.href).searchParams.get("identity")).toBe(firstScope);
    expect(document.body.textContent).not.toContain("This session is not in Morty Recent sessions");
});
