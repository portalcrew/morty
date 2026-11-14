import { getByRole, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { readyComposer } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";

test("Given a connected computer, When Morty revokes its Computer, Then the page says it was disconnected for security and how to reconnect it, without offering a retry", {
    timeout: 45_000,
}, async () => {
    const clock = new TestClock("2026-11-09T08:00:00Z");
    const app = await createTestApp({ connectAgent: true, clock });
    await readyComposer(app);
    if (app.daemon === null) {
        throw new Error("Expected the connected Computer");
    }

    await app.daemon.revoke();

    await app.waitForView(
        () => expect(document.body.textContent).toContain("This computer was disconnected for your security"),
        30_000,
    );
    expect(document.body.textContent).toContain("Run the Morty setup prompt on that computer again to reconnect it.");
    expect(getByRole(document.body, "button", { name: "Send message" })).toHaveProperty("disabled", true);
    expect(queryByRole(document.body, "button", { name: "Retry now" })).toBeNull();
    expect(document.body.textContent).not.toContain("npx @morty-build/cli@latest start");
});
