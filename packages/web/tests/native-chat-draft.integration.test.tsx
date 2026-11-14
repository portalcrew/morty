import { getByRole, queryByRole } from "@testing-library/dom";
import { expect, onTestFinished, test, vi } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { readyComposer, sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given New Chat is a browser draft, When I abandon one draft and send another's first prompt, Then only the sent conversation appears with its harness identity and survives reload", {
    timeout: 30_000,
}, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-07T00:00:00.000Z"));
    onTestFinished(() => {
        vi.useRealTimers();
    });
    const app = await createTestApp({ connectAgent: true });
    let composer = await readyComposer(app);
    await app.user.click(composer);
    await app.user.paste("An abandoned draft");
    expect(new URL(window.location.href).searchParams.get("sessionId")).toBeNull();
    expect(queryByRole(document.body, "button", { name: "An abandoned draft" })).toBeNull();
    await app.user.click(getByRole(document.body, "button", { name: "New Session" }));
    composer = await readyComposer(app);
    expect(composer).toHaveProperty("value", "");
    await sendPrompt(app, composer, "Continue the harness-owned conversation");
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Continue the harness-owned conversation")),
        ).toBe(true),
    );
    const sessionId = new URL(window.location.href).searchParams.get("sessionId");
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);
    expect(app.elementsByTestId(dataTestId.userMessage)).toHaveLength(1);
    const reloaded = await app.reload();
    await reloaded.waitForView(() =>
        expect(
            reloaded
                .elementsByTestId(dataTestId.userMessage)
                .some((element) => element.textContent?.includes("Continue the harness-owned conversation")),
        ).toBe(true),
    );
    expect(new URL(window.location.href).searchParams.get("sessionId")).toBe(sessionId);
    expect(reloaded.elementsByTestId(dataTestId.userMessage)).toHaveLength(1);
});
