import { getByRole, queryByRole } from "@testing-library/dom";
import { act, fireEvent } from "@testing-library/react";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

test("Given the chat sidebar, When the user clicks an icon action and closes what it opened, Then its tooltip stays closed", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap", identity: true } });
    await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));

    const share = await app.queryElementByTestId(dataTestId.shareIdentity);
    await app.user.click(share);
    const sharing = getByRole(document.body, "dialog", { name: "Continue on another device" });
    await app.user.click(getByRole(sharing, "button", { name: "Close dialog" }));
    expect(queryByRole(document.body, "tooltip")).toBeNull();

    const bug = getByRole(document.body, "button", { name: "Report a bug" });
    await app.user.click(bug);
    const bugReport = getByRole(document.body, "dialog", { name: "Report a bug" });
    await app.user.click(getByRole(bugReport, "button", { name: "Close dialog" }));
    expect(queryByRole(document.body, "tooltip")).toBeNull();

    const userMenu = await app.queryElementByTestId(dataTestId.userMenu);
    await app.user.click(userMenu);
    await app.waitForView(() => getByRole(document.body, "menuitem", { name: "Network latency" }));
    fireEvent.pointerDown(document.body);
    expect(queryByRole(document.body, "tooltip")).toBeNull();
});

test("Given the chat sidebar, When a keyboard user opens and closes sharing, Then focus returns to the action and shows its tooltip", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap", identity: true } });
    await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));

    const share = await app.queryElementByTestId(dataTestId.shareIdentity);
    // happy-dom does not synthesize a click from Enter, so activate the focused
    // action directly; a keyboard-activated click carries no pointer detail.
    share.focus();
    await act(async () => {
        share.click();
    });
    const sharing = getByRole(document.body, "dialog", { name: "Continue on another device" });
    await app.user.keyboard("{Escape}");
    expect(document.body.contains(sharing)).toBe(false);
    expect(document.activeElement).toBe(share);
    expect(getByRole(document.body, "tooltip", { name: "Continue on another device" })).toBeTruthy();
});

test("Given the mobile chat navigation, When its header renders, Then it leaves eight pixels above and below the controls", {
    timeout: 30_000,
}, async () => {
    const desktopViewport = { height: window.innerHeight, width: window.innerWidth };
    window.happyDOM.setViewport({ height: 844, width: 413 });
    let app: TestApp | null = null;
    try {
        app = await createTestApp({ connectAgent: true });
        await app.queryElementByTestId(dataTestId.messageComposer);
        const header = getByRole(document.body, "button", { name: "New Session" }).closest("header");
        expect(header).toBeInstanceOf(HTMLElement);
        if (!(header instanceof HTMLElement)) {
            throw new Error("Expected the mobile chat navigation header");
        }
        expect(header.classList.contains("py-0")).toBe(true);
        expect(header.classList.contains("max-sm:py-2")).toBe(true);
    } finally {
        if (app !== null) {
            await app.close();
        }
        window.happyDOM.setViewport(desktopViewport);
    }
});
