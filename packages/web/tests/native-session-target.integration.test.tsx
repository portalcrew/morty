import { getByRole } from "@testing-library/dom";
import { expect, onTestFinished, test, vi } from "vitest";
import { openExecutionDetails, readyComposer } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

test("Given two Computers contain the same native pair, When I draft on one and open the other, Then each Computer keeps its own composer draft", {
    timeout: 30_000,
}, async () => {
    vi.useFakeTimers({ now: new Date("2026-11-09T00:00:00Z"), toFake: ["Date"] });
    onTestFinished(() => {
        vi.useRealTimers();
    });
    const sessionId = "shared-computer-native-session";
    const open = async (app: TestApp) => {
        await readyComposer(app);
        await app.user.click(getByRole(document.body, "button", { name: "Open Session" }));
        const dialog = await app.waitForView(() => getByRole(document.body, "dialog", { name: "Open Session" }));
        await app.user.click(
            await app.waitForView(() => {
                const button = getByRole(dialog, "button", { name: "Open" });
                expect(button).toHaveProperty("disabled", false);
                return button;
            }),
        );
        await app.waitForView(() => {
            expect(new URL(window.location.href).searchParams.get("sessionId")).toBe(sessionId);
            expect(getComputedStyle(document.body).pointerEvents).not.toBe("none");
        });
        return await readyComposer(app);
    };
    const first = await createTestApp({ connectAgent: true, sessionIds: new Set([sessionId]) });
    await open(first);
    const composer = await readyComposer(first);
    await first.user.type(composer, "Private draft on the first Computer");
    await first.close();
    const second = await createTestApp({ connectAgent: true, sessionIds: new Set([sessionId]) });
    await open(second);
    const otherComposer = await readyComposer(second);
    expect(otherComposer).toHaveProperty("value", "");
    await second.user.type(otherComposer, "Draft on the second Computer");
    const reloaded = await second.reload();
    expect(await readyComposer(reloaded)).toHaveProperty("value", "Draft on the second Computer");
});

test.each([
    { harness: "claude", label: "Claude Code" },
    { harness: "codex", label: "Codex" },
])(
    "Given two harnesses share a native ID, When I open $label and reload, Then the address retains the pair and only that harness is restored",
    {
        timeout: 30_000,
    },
    async ({ harness, label }) => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-09-07T00:00:00.000Z"));
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const sessionId = "shared-native-session";
        const app = await createTestApp({
            connectAgent: true,
            agents: [
                { harness: "claude", label: "Claude Code" },
                { harness: "codex", label: "Codex" },
            ],
            sessionIds: new Set([sessionId]),
        });
        await readyComposer(app);
        await app.user.click(getByRole(document.body, "button", { name: "Open Session" }));
        const dialog = await app.waitForView(() => getByRole(document.body, "dialog", { name: "Open Session" }));
        await app.user.click(await app.waitForView(() => getByRole(dialog, "tab", { name: label })));
        const open = await app.waitForView(() => {
            const button = getByRole(dialog, "button", { name: "Open" });
            expect(button).toHaveProperty("disabled", false);
            return button;
        });
        await app.user.click(open);
        await readyComposer(app);
        await app.waitForView(() => {
            const address = new URL(window.location.href);
            expect(address.searchParams.get("harness")).toBe(harness);
            expect(address.searchParams.get("sessionId")).toBe(sessionId);
        });
        const reloaded = await app.reload();
        await readyComposer(reloaded);
        expect((await openExecutionDetails(reloaded)).textContent).toContain(label);
    },
);
