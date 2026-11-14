import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { readyComposer, sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given a pointer device, When I send a message, Then the composer keeps focus for the next message", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const composer = await readyComposer(app);

    await sendPrompt(app, composer, "Hello");
    await app.waitForView(() => expect(app.elementsByTestId(dataTestId.agentResponse).length).toBeGreaterThan(0));

    expect(app.elementByTestId(dataTestId.messageComposer)).toBe(document.activeElement);
});
