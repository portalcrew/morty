import { getAllByRole, getByRole, getByText, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given a conversation with two finished replies, When I fork it from the latest reply, Then its copy opens and again only its latest reply offers a fork", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const replies = () => getAllByRole(document.body, "article", { name: "Agent response" });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Plan the release");
    await app.waitForView(() => getByRole(replies()[0] ?? document.body, "button", { name: "Copy response" }));
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Draft the notes");
    const latest = await app.waitForView(() => {
        const reply = replies()[1];
        if (reply === undefined) {
            throw new Error("Expected the second reply");
        }
        getByRole(reply, "button", { name: "Copy response" });
        return reply;
    });

    expect(getAllByRole(document.body, "button", { name: "Fork session" })).toHaveLength(1);
    expect(queryByRole(replies()[0] ?? document.body, "button", { name: "Fork session" })).toBeNull();
    await app.user.click(getByRole(latest, "button", { name: "Fork session" }));

    await app.waitForView(() => getByRole(document.body, "heading", { name: /\(Fork #1\)$/u }));
    getByRole(document.body, "button", { name: "Open Plan the release" });
    const copied = await app.waitForView(() => {
        const [first, second] = replies();
        if (first === undefined || second === undefined) {
            throw new Error("Expected the copied replies");
        }
        getByText(first, /Plan the release/u);
        getByText(second, /Draft the notes/u);
        return second;
    });
    expect(getAllByRole(document.body, "button", { name: "Fork session" })).toHaveLength(1);
    getByRole(copied, "button", { name: "Fork session" });
    await app.close();
});
