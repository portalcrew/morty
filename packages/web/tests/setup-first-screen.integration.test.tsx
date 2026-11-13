import { fireEvent, getAllByRole, getByRole, getByText, queryByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, test } from "vitest";
import { createTestApp } from "./infra/test-app.tsx";

test("Given a new visitor, When the setup page opens, Then it explains what Morty is for, why it can be trusted, and where to verify that", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap" } });
    await app.waitForView(() => getByRole(document.body, "button", { name: "Copy setup prompt" }));

    expect(getAllByRole(document.body, "heading")).toHaveLength(1);
    expect(getByRole(document.body, "heading", { level: 1 })).toHaveProperty(
        "textContent",
        "Step away. Keep your agent working.",
    );
    expect(getByRole(document.body, "region", { name: "Step away. Keep your agent working." })).toHaveProperty(
        "className",
        expect.stringContaining("max-w-[460px]"),
    );
    expect(getByRole(document.body, "figure", { name: "Codex, Claude Code, and Pi connect to Morty" })).toBeInstanceOf(
        HTMLElement,
    );
    expect(document.body.textContent).toContain(
        "Check in and reply from any browser. Your agent keeps running on your computer.",
    );
    const repository = "https://github.com/portalcrew/morty";
    expect(getByRole(document.body, "button", { name: /^GitHub/ }).tagName).toBe("BUTTON");
    for (const [name, href] of [
        ["How Morty handles data", `${repository}#what-morty-does-with-your-data`],
        ["Security", `${repository}/blob/main/SECURITY.md`],
        ["Report an issue", `${repository}/issues/new`],
    ]) {
        expect(getByRole(document.body, "link", { name: new RegExp(`^${name}`) })).toHaveProperty("href", href);
    }
    expect(getByText(document.body, "Next: paste it into the agent running on your computer.")).toBeInstanceOf(
        HTMLElement,
    );
    const collapsedDetails = getByRole(document.body, "group", { name: "Setup details" });
    expect(collapsedDetails).toHaveProperty("open", false);
    expect(collapsedDetails.contains(getByText(document.body, /Keep that computer awake and online\./))).toBe(false);
    expect(queryByRole(document.body, "status", { name: "Setup next step" })).toBeNull();
});

test("Given a new visitor reviewing setup, When they expand its details, Then they read what it installs, runs, stores and shares before copying the prompt", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap" } });
    await app.waitForView(() => getByRole(document.body, "button", { name: "Copy setup prompt" }));
    await app.user.click(getByText(document.body, "Review what setup does", { exact: true }));

    const steps = getAllByRole(getByRole(document.body, "list", { name: "What setup does" }), "listitem");
    expect(steps.map((step) => step.textContent)).toEqual([
        "Installs the Morty CLI (@morty-build/cli) from npm. Use npx @morty-build/cli@latest restart to install updates.",
        "Runs a background connection until restart or morty stop.",
        "Keeps this computer's Morty identity in your user data folder.",
        "Asks before replacing a missing connection, which ends earlier shared access.",
        "Returns a private link for one device, valid for 10 minutes. That device can control your agent for one day unless you revoke access; ask the agent for 1 hour, 7 days or 30 days instead.",
    ]);
    expect(getByRole(document.body, "link", { name: /^Read setup\.md/ })).toHaveProperty(
        "href",
        `${window.location.origin}/setup.md`,
    );
});

test("Given a new visitor on a phone, When they send Morty to their computer, Then the share sheet receives Morty's address", {
    timeout: 30_000,
}, async () => {
    const shared: ShareData[] = [];
    const app = await createTestApp({
        page: { kind: "bootstrap" },
        setupHandoff: {
            kind: "send-link",
            share: async (data) => {
                shared.push(data);
            },
        },
    });
    const send = await app.waitForView(() => getByRole(document.body, "button", { name: "Send to my computer" }));
    expect(queryByRole(document.body, "button", { name: "Copy setup prompt" })).toBeNull();
    expect(document.body.textContent).toContain("Setup runs on your computer. Open Morty there to copy the prompt.");

    await app.user.click(send);

    await app.waitForView(() =>
        expect(shared).toEqual([
            {
                text: "Set up Morty on the computer where your agent runs.",
                title: "Morty",
                url: `${window.location.origin}/`,
            },
        ]),
    );
});

test("Given a new visitor whose agent is busy, When the setup page opens, Then it warns before copying that setup interrupts the agent's current task", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap" } });
    await app.waitForView(() => getByRole(document.body, "button", { name: "Copy setup prompt" }));

    const warning = getByText(
        document.body,
        /^Setup interrupts the agent's current task; continue it here afterwards\./,
    );
    expect(getByRole(document.body, "group", { name: "Setup details" }).contains(warning)).toBe(false);
});

test("Given a new visitor, When they copy the instruction, Then the clipboard holds setup and a persistent next step explains where to paste it", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap" } });
    const copy = await app.waitForView(() => getByRole(document.body, "button", { name: "Copy setup prompt" }));

    await app.user.click(copy);
    const instruction = await navigator.clipboard.readText();
    expect(instruction).toBe(
        `Fetch ${window.location.origin}/setup.md and complete the Morty setup for me. You may install missing prerequisites and pair this computer.`,
    );
    const nextStep = getByRole(document.body, "status", { name: "Setup next step" });
    expect(nextStep.textContent).toContain("Paste into your agent, then open the link it returns.");
    await app.user.click(getByText(document.body, "Review what setup does", { exact: true }));
    const pairing = getByRole(document.body, "textbox", { name: "Agent setup prompt" });
    expect(pairing).toHaveProperty("value", instruction);
    await app.user.click(pairing);
    expect(getByRole(document.body, "status", { name: "Setup next step" })).toBe(nextStep);
});

test("Given the first screen, When the user reaches the copy button by keyboard and activates it, Then the clipboard holds the full instruction and the button reports Copied", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap" } });
    const copy = await app.waitForView(() => getByRole(document.body, "button", { name: "Copy setup prompt" }));
    expect(document.activeElement).not.toBe(copy);

    copy.focus();
    await app.user.keyboard("{Enter}");

    const instruction = await navigator.clipboard.readText();
    expect(instruction).toContain(`${window.location.origin}/setup.md`);
    await app.user.click(getByText(document.body, "Review what setup does", { exact: true }));
    expect(getByRole(document.body, "textbox", { name: "Agent setup prompt" })).toHaveProperty("value", instruction);
    expect(getByRole(document.body, "button", { name: "Copied" })).toBeInstanceOf(HTMLButtonElement);
    expect(document.body.textContent).toContain("Paste into your agent, then open the link it returns.");
});

test("Given a user wants to inspect or manually copy setup, When they expand the instruction, Then they can select its full text and read the local execution details", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap" } });
    await app.waitForView(() => getByRole(document.body, "button", { name: "Copy setup prompt" }));
    await app.user.click(getByText(document.body, "Review what setup does", { exact: true }));
    expect(getByRole(document.body, "group", { name: "Setup details" })).toHaveProperty("open", true);

    const pairing = getByRole(document.body, "textbox", { name: "Agent setup prompt" });
    if (!(pairing instanceof HTMLTextAreaElement)) {
        throw new Error("Expected a selectable setup instruction");
    }
    await app.user.click(pairing);

    expect(pairing.readOnly).toBe(true);
    expect(pairing.value).toContain(`${window.location.origin}/setup.md`);
    expect(pairing.selectionStart).toBe(0);
    expect(pairing.selectionEnd).toBe(pairing.value.length);
    expect(document.body.textContent).toContain("Keep that computer awake and online.");
});

test("Given the first screen, When the user clicks Copy again after success, Then the instruction is copied again", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap" } });

    await app.user.click(
        await app.waitForView(() => getByRole(document.body, "button", { name: "Copy setup prompt" })),
    );
    const copied = getByRole(document.body, "button", { name: "Copied" });
    const instruction = await navigator.clipboard.readText();
    expect(instruction).toContain(`${window.location.origin}/setup.md`);

    await app.user.click(copied);

    expect(await navigator.clipboard.readText()).toBe(instruction);
    expect(getByRole(document.body, "button", { name: "Copied" })).toBeInstanceOf(HTMLButtonElement);
});

test("Given the setup prompt was just copied, When its confirmation animation completes, Then the copy button returns to its default affordance and can copy again", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap" } });
    const copy = await app.waitForView(() => getByRole(document.body, "button", { name: "Copy setup prompt" }));

    await act(async () => {
        fireEvent.click(copy);
    });
    expect(await navigator.clipboard.readText()).toContain(`${window.location.origin}/setup.md`);
    const copied = getByRole(document.body, "button", { name: "Copied" });
    expect(copied).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
        fireEvent.animationEnd(copied, { animationName: "copy-confirmation" });
    });
    const restored = getByRole(document.body, "button", { name: "Copy setup prompt" });
    expect(restored).toBeInstanceOf(HTMLButtonElement);
    expect(getByRole(document.body, "status", { name: "Setup next step" }).textContent).toContain(
        "Paste into your agent, then open the link it returns.",
    );

    await act(async () => {
        fireEvent.click(restored);
    });
    expect(getByRole(document.body, "button", { name: "Copied" })).toBeInstanceOf(HTMLButtonElement);
});
