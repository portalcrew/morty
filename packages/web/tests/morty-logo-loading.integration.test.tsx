import { fireEvent, getByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

test("Given the Morty logo is still loading, When it finishes loading, Then the placeholder is replaced by the mark without moving the navigation", async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId("chat-message-composer");
    const navigation = getByRole(document.body, "complementary", { name: "Morty navigation" });
    const logo = navigation.querySelector(`[data-testid="${dataTestId.mortyLogo}"]`);
    expect(logo?.getAttribute("data-state")).toBe("loading");
    expect(logo?.querySelector('[aria-hidden="true"]')).not.toBeNull();
    const mark = logo?.querySelector("img");
    expect(mark).toBeInstanceOf(HTMLImageElement);
    if (!(mark instanceof HTMLImageElement)) {
        throw new Error("Expected the Morty mark image");
    }
    expect(mark.className).toContain("opacity-0");

    fireEvent.load(mark);

    expect(logo?.getAttribute("data-state")).toBe("loaded");
    expect(logo?.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(mark.className).toContain("opacity-100");
});

test("Given the mobile chat navigation, When the Morty mark renders, Then the logo is 26 by 26", {
    timeout: 30_000,
}, async () => {
    const desktopViewport = { height: window.innerHeight, width: window.innerWidth };
    window.happyDOM.setViewport({ height: 844, width: 413 });
    let app: TestApp | null = null;
    try {
        app = await createTestApp({ connectAgent: true });
        await app.queryElementByTestId(dataTestId.messageComposer);
        const navigationButton = getByRole(document.body, "button", { name: "Open navigation" });
        const logo = navigationButton.querySelector(`[data-testid="${dataTestId.mortyLogo}"]`);
        expect(logo).toBeInstanceOf(HTMLElement);
        if (!(logo instanceof HTMLElement)) {
            throw new Error("Expected the mobile Morty mark");
        }
        expect(logo.style.width).toBe("26px");
        expect(logo.style.height).toBe("26px");
        const mark = logo.querySelector("img");
        expect(mark?.getAttribute("width")).toBe("26");
        expect(mark?.getAttribute("height")).toBe("26");
    } finally {
        if (app !== null) {
            await app.close();
        }
        window.happyDOM.setViewport(desktopViewport);
    }
});
