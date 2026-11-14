import { getByRole, getByText, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { readyComposer, sendPrompt, showReconnectNotice } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";

for (const agent of [
    { harness: "claude", label: "Claude Code", title: "Claude Code needs sign-in", command: "claude" },
    { harness: "codex", label: "Codex", title: "Codex needs authentication", command: "codex" },
    { harness: "pi", label: "Pi", title: "Pi's model provider needs authentication", command: "pi" },
]) {
    test(`Given ${agent.label} requires authentication, When I send a message and retry after reloading, Then one notice offers recovery steps and preserves my draft`, {
        timeout: 30_000,
    }, async () => {
        const clock = new TestClock("2026-10-28T08:00:00Z");
        const app = await createTestApp({ connectAgent: true, agent, clock });
        const initialComposer = await readyComposer(app);
        await sendPrompt(app, initialComposer, "require agent authentication");
        const notice = await app.waitForView(() => {
            const alert = getByRole(getByRole(document.body, "log", { name: "Messages" }), "alert");
            expect(alert.textContent).toContain(agent.title);
            return alert;
        });
        const composer = await readyComposer(app);
        expect(notice.textContent).toContain("Controlled Agent Runtime");
        expect(queryByRole(composer.closest("form") ?? document.body, "alert")).toBeNull();
        const details = getByText(notice, "Technical details").closest("details");
        const steps = getByText(notice, "View steps").closest("details");
        expect(details).toHaveProperty("open", false);
        expect(steps).toHaveProperty("open", false);
        await app.user.type(composer, "Keep my next message");
        await app.user.click(getByText(notice, "View steps"));
        expect(steps).toHaveProperty("open", true);
        expect(steps?.textContent).toContain(`Run ${agent.command}`);
        expect(steps?.textContent).toContain("send your message again");
        if (agent.harness === "pi") {
            expect(steps?.textContent).toContain("/login");
            expect(steps?.textContent).toContain("API key");
        }
        await app.user.click(getByText(notice, "Technical details"));
        expect(details).toHaveProperty("open", true);
        expect(details?.textContent).toContain("authentication_required");
        expect(composer).toHaveProperty("value", "Keep my next message");
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).not.toContain("Keep my next message");
        if (agent.harness === "claude") {
            if (app.daemon === null) {
                throw new Error("Expected the connected Computer");
            }
            await app.daemon.disconnect();
            await showReconnectNotice(app, clock);
            await app.waitForView(() =>
                expect(app.elementByTestId(dataTestId.sessionReconnectNotice).textContent).toContain("Retrying in"),
            );
            await app.daemon.reconnect();
            await app.user.click(getByRole(document.body, "button", { name: "Retry now" }));
            await app.waitForView(() => {
                getByRole(document.body, "button", { name: /Switch computer/, description: "Connection available" });
                expect(app.optionalElementByTestId(dataTestId.sessionReconnectNotice)).toBeNull();
                expect(getByRole(document.body, "alert").textContent).toContain(agent.title);
            });
            expect(app.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", "Keep my next message");
        }
        const reloaded = await app.reload();
        const restoredComposer = await readyComposer(reloaded);
        expect(restoredComposer).toHaveProperty("value", "Keep my next message");
        const messages = getByRole(document.body, "log", { name: "Messages" });
        expect(messages.textContent).not.toContain("Keep my next message");
        expect(messages.textContent).not.toContain("Agent authentication is required");
        await reloaded.user.clear(restoredComposer);
        await sendPrompt(reloaded, restoredComposer, "require agent authentication");
        await reloaded.waitForView(() => {
            expect(getByRole(document.body, "alert").textContent).toContain(agent.title);
            expect(queryByRole(restoredComposer.closest("form") ?? document.body, "alert")).toBeNull();
        });
        expect(getByText(document.body, "Technical details").closest("details")).toHaveProperty("open", false);
    });
}
