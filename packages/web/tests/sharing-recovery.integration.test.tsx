import { getByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import * as v from "valibot";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { createTestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";
import { createChatWorkerEnvironment, dedicatedEnvironmentTimeout } from "./support/chat-worker.ts";

test("Given a sharing replacement committed before its reply was lost, When the user chooses a shorter term and retries, Then only the displayed latest link grants access", {
    timeout: dedicatedEnvironmentTimeout,
}, async () => {
    const environment = await createChatWorkerEnvironment(false, false, true);
    const clock = new TestClock("2026-11-09T00:00:00Z");
    const app = await createTestApp({
        environment,
        connectAgent: true,
        clock,
        page: { kind: "bootstrap", identity: true },
    });
    try {
        const network = app.sharingNetwork;
        if (network === null) {
            throw new Error("Missing sharing response network");
        }
        await app.user.click(await app.queryElementByTestId(dataTestId.shareIdentity));
        const dialog = getByRole(document.body, "dialog", { name: "Continue on another device" });
        const copy = async () => {
            await app.user.click(await app.waitForView(() => getByRole(dialog, "button", { name: "Copy link" })));
            return new URL(await navigator.clipboard.readText());
        };
        const original = await copy();
        const held = network.holdNextSharingResponse();
        await app.user.click(getByRole(dialog, "combobox", { name: "Device access" }));
        await app.user.click(getByRole(document.body, "option", { name: "7 days" }));
        const committed = new URL(v.parse(v.object({ url: v.string() }), JSON.parse(await held.received)).url);
        await app.user.click(getByRole(dialog, "combobox", { name: "Device access" }));
        await app.user.click(getByRole(document.body, "option", { name: "1 hour" }));
        await act(async () => held.disconnect());
        const retry = await app.waitForView(() => getByRole(dialog, "button", { name: "Retry sharing link" }));
        await act(async () => clock.advanceBy(1_000));
        await app.user.click(retry);
        const current = await copy();
        expect(getByRole(dialog, "combobox", { name: "Device access" }).textContent).toContain("1 hour");
        const redeem = (url: URL) =>
            app.transport.request(
                new Request(new URL("/morty/api/v1/identity/transfers/redeem", app.origin), {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ code: new URLSearchParams(url.hash.slice(1)).get("code") }),
                    signal: AbortSignal.timeout(15_000),
                }),
            );
        expect((await redeem(original)).status).toBe(410);
        expect((await redeem(committed)).status).toBe(410);
        expect((await redeem(current)).status).toBe(200);
    } finally {
        await app.close();
        await environment.close();
    }
});
