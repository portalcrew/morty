import type { DetachedWindowAPI } from "happy-dom";
import { afterEach, expect, test } from "vitest";
import { readyComposer } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

declare global {
    interface Window {
        readonly happyDOM: DetachedWindowAPI;
    }
}

const keyboardHeightPx = 300;
const originalViewport = { height: window.innerHeight, width: window.innerWidth };
const marker = "data-software-keyboard";

afterEach(() => {
    window.happyDOM.setViewport(originalViewport);
});

function openKeyboard(): void {
    window.happyDOM.setViewport({ height: originalViewport.height - keyboardHeightPx });
}

async function openComposer() {
    const app = await createTestApp({ connectAgent: true });
    const composer = await readyComposer(app);
    const form = composer.closest("form");
    if (form === null) {
        throw new Error("The composer is not inside a form");
    }
    return { app, composer, form };
}

test("Given a software keyboard shrinks the viewport, When I focus the composer, Then it marks the keyboard open until focus leaves", {
    timeout: 30_000,
}, async () => {
    const { app, composer, form } = await openComposer();

    await app.user.click(composer);
    expect(form.getAttribute(marker)).toBeNull();

    openKeyboard();
    expect(form.getAttribute(marker)).toBe("open");

    composer.blur();
    expect(form.getAttribute(marker)).toBeNull();
});

test("Given the keyboard is still open after the composer lost focus, When I focus the composer again, Then it marks the keyboard open", {
    timeout: 30_000,
}, async () => {
    const { app, composer, form } = await openComposer();

    await app.user.click(composer);
    openKeyboard();
    composer.blur();
    expect(form.getAttribute(marker)).toBeNull();

    await app.user.click(composer);
    expect(document.activeElement).toBe(composer);
    expect(form.getAttribute(marker)).toBe("open");
});

test("Given a focused composer on a viewport that barely changes, When the page resizes slightly, Then the safe-area margin stays", {
    timeout: 30_000,
}, async () => {
    const { app, composer, form } = await openComposer();

    await app.user.click(composer);
    window.happyDOM.setViewport({ height: originalViewport.height - 40 });

    expect(form.getAttribute(marker)).toBeNull();
});
