import { getByRole, getByText, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { createTestApp } from "./infra/test-app.tsx";

for (const path of ["/unknown-page", "/chat/unknown", "/continue/unknown", "/setup/unknown", "/chatty"]) {
    test(`Given an unpaired visitor, When they open ${path}, Then they see a not-found page with a way home instead of setup`, async () => {
        const app = await createTestApp({ page: { kind: "url", path: `${path}?token=private-token` } });
        await app.waitForView(() => getByRole(document.body, "heading", { name: "Page not found", level: 1 }));
        expect(getByText(document.body, "404")).toBeInstanceOf(HTMLElement);
        expect(getByRole(document.body, "link", { name: "Go to Morty home" })).toHaveProperty(
            "href",
            `${window.location.origin}/`,
        );
        expect(queryByRole(document.body, "button", { name: "Copy setup prompt" })).toBeNull();
        expect(document.body.textContent).not.toMatch(/private-token/);
    });
}

test("Given a paired visitor, When they open an unknown page, Then they see the same not-found screen", async () => {
    const app = await createTestApp({ page: { kind: "bootstrap", identity: true } });
    window.history.replaceState(null, "", "/unknown-page");
    const reloaded = await app.reload();
    await reloaded.waitForView(() => getByRole(document.body, "heading", { name: "Page not found", level: 1 }));
    expect(getByRole(document.body, "link", { name: "Go to Morty home" })).toHaveProperty(
        "href",
        `${window.location.origin}/`,
    );
});
