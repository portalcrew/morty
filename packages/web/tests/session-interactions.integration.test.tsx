import { getByRole, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt, showReconnectNotice } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";

async function requestInput(prompt = "request user input") {
    const app = await createTestApp({
        connectAgent: true,
        agent: { harness: "interaction-test", label: "Interaction Agent" },
    });
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the composer");
    }
    await sendPrompt(app, composer, prompt);
    await app.waitForView(() => getByRole(document.body, "alertdialog", { name: "Agent permission request" }));
    return app;
}

for (const empty of [false, true]) {
    test(`Given an agent requests text and a multiline draft, When the user ${empty ? "clears" : "edits"} both answers and skips optional constrained strings, Then the exact text reaches the agent without optional values`, {
        timeout: 30_000,
    }, async () => {
        const app = await createTestApp({
            connectAgent: true,
            agent: { harness: "interaction-test", label: "Interaction Agent" },
        });
        const composer = await app.queryElementByTestId(dataTestId.messageComposer);
        if (!(composer instanceof HTMLTextAreaElement)) {
            throw new Error("Expected the composer");
        }
        await sendPrompt(app, composer, "request text answers");
        const form = await app.waitForView(() =>
            getByRole(document.body, "dialog", { name: "Agent information request" }),
        );
        const name = getByRole(form, "textbox", { name: "Name" });
        const draft = getByRole(form, "textbox", { name: "Draft" });
        expect(getByRole(form, "textbox", { name: "Optional nickname" })).toBeDefined();
        expect(getByRole(form, "textbox", { name: "Optional code" })).toBeDefined();
        expect(draft).toBeInstanceOf(HTMLTextAreaElement);
        if (!(draft instanceof HTMLTextAreaElement)) {
            throw new Error("Expected a multiline editor");
        }
        expect(draft.value).toBe(`${String.fromCodePoint(0x7b2c, 0x4e00, 0x884c)}\nSecond line`);
        await app.user.clear(name);
        await app.user.clear(draft);
        const nameValue = empty ? "" : `${String.fromCodePoint(0x59da)} 🌊`;
        const draftValue = empty
            ? ""
            : `${String.fromCodePoint(0x6539, 0x5199, 0x7b2c, 0x4e00, 0x884c)}\nSecond line\n${String.fromCodePoint(0x7b2c, 0x4e09, 0x884c)}`;
        if (!empty) {
            await app.user.type(name, nameValue);
            await app.user.type(draft, draftValue);
        }
        await app.user.click(getByRole(form, "button", { name: "Continue" }));
        await app.waitForView(() =>
            expect(document.body.textContent).toContain(
                `"content":${JSON.stringify({ name: nameValue, draft: draftValue })}`,
            ),
        );
        expect(queryByRole(document.body, "dialog", { name: "Agent information request" })).toBeNull();
    });
}

test("Given a half-typed answer to the agent's question, When the user switches to another conversation and back, Then the answer is still there and is what the agent receives", {
    timeout: 60_000,
}, async () => {
    const app = await createTestApp({
        connectAgent: true,
        agent: { harness: "interaction-test", label: "Interaction Agent" },
    });
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the composer");
    }
    await sendPrompt(app, composer, "request text answers");
    const form = await app.waitForView(() => getByRole(document.body, "dialog", { name: "Agent information request" }));
    await app.user.clear(getByRole(form, "textbox", { name: "Name" }));
    await app.user.type(getByRole(form, "textbox", { name: "Name" }), "Half typed");

    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    await app.user.click(
        await app.waitForView(() => {
            const entry = app
                .elementsByTestId(dataTestId.managedConversation)
                .find((element) => element.textContent?.includes("request text answers") === true);
            if (entry === undefined) {
                throw new Error("Expected the conversation in the sidebar");
            }
            return entry;
        }),
    );
    const returned = await app.waitForView(() =>
        getByRole(document.body, "dialog", { name: "Agent information request" }),
    );
    const name = getByRole(returned, "textbox", { name: "Name" });
    expect(name).toHaveProperty("value", "Half typed");

    await app.user.type(name, " answer");
    await app.user.click(getByRole(returned, "button", { name: "Continue" }));
    await app.waitForView(() => expect(document.body.textContent).toContain('"name":"Half typed answer"'));
});

test("Given the agent asks a question, When the user reads and answers it, Then Chat shows a waiting status instead of working and clears it after the answer", {
    timeout: 30_000,
}, async () => {
    const app = await requestInput();
    await app.user.click(getByRole(document.body, "button", { name: "Allow" }));
    const form = await app.waitForView(() => getByRole(document.body, "dialog", { name: "Agent information request" }));
    expect(getByRole(form, "status", { name: "Waiting for your answer" }).textContent).toBe("Waiting for your answer");
    expect(queryByRole(document.body, "status", { name: "Agent is working" })).toBeNull();
    expect(document.body.querySelector(".animate-loading-text-shimmer")).toBeNull();

    await app.user.type(getByRole(form, "textbox", { name: "Branch" }), "feature/answer-status");
    await app.user.click(getByRole(form, "button", { name: "Continue" }));
    await app.waitForView(() => expect(document.body.textContent).toContain("Selected branch: feature/answer-status"));
    expect(queryByRole(document.body, "status", { name: "Waiting for your answer" })).toBeNull();
    expect(queryByRole(document.body, "dialog", { name: "Agent information request" })).toBeNull();
});

test("Given a pending permission, When Chat remounts and the user allows it and answers the form, Then the agent receives the answer and both cards disappear", {
    timeout: 30_000,
}, async () => {
    const app = await requestInput();
    const initial = getByRole(document.body, "alertdialog", { name: "Agent permission request" });
    expect(initial.textContent).toContain("$ pnpm test -- --reporter=verbose");
    expect(document.body.querySelector(".animate-loading-text-shimmer")).toBeNull();
    await app.user.click(getByRole(initial, "button", { name: /Details ·/ }));
    expect(initial.textContent).toContain("src/<entry>.ts");
    app.remount();
    const permission = await app.waitForView(() =>
        getByRole(document.body, "alertdialog", { name: "Agent permission request" }),
    );
    expect(permission.textContent).toContain("$ pnpm test -- --reporter=verbose");
    await app.user.click(getByRole(permission, "button", { name: /Details ·/ }));
    expect(permission.textContent).toContain("src/<entry>.ts");
    await app.user.click(getByRole(permission, "button", { name: "Allow" }));
    const form = await app.waitForView(() => getByRole(document.body, "dialog", { name: "Agent information request" }));
    await app.user.type(getByRole(form, "textbox", { name: "Branch" }), "feature/separation");
    await app.user.click(getByRole(form, "button", { name: "Continue" }));
    await app.waitForView(() => expect(document.body.textContent).toContain("Selected branch: feature/separation"));
    expect(queryByRole(document.body, "alertdialog", { name: "Agent permission request" })).toBeNull();
    expect(queryByRole(document.body, "dialog", { name: "Agent information request" })).toBeNull();
});

test("Given the agent asks to edit a file it announced, When the user reviews the request, Then the card shows the change as before and after text and keeps the full input in its details", {
    timeout: 30_000,
}, async () => {
    const app = await requestInput("request file edit");
    const permission = getByRole(document.body, "alertdialog", { name: "Agent permission request" });
    expect(permission.textContent).toContain("Edit src/todo.ts");
    expect(permission.textContent).toContain("  return list.length;");
    expect(permission.textContent).toContain("  const next = list.length + 1;\n  return next;");
    expect(permission.textContent).not.toContain('"new_string"');
    await app.user.click(getByRole(permission, "button", { name: /Details ·/ }));
    expect(permission.textContent).toContain('"replace_all": false');
    await app.user.click(getByRole(permission, "button", { name: "Allow" }));
    await app.waitForView(() => expect(document.body.textContent).toContain("Edit decision: allow-once"));
});

test("Given a pending permission, When the user rejects it, Then the agent receives the rejection without showing an input form", {
    timeout: 30_000,
}, async () => {
    const app = await requestInput();
    await app.user.click(getByRole(document.body, "button", { name: "Deny" }));
    await app.waitForView(() => expect(document.body.textContent).toContain("Permission rejected"));
    expect(queryByRole(document.body, "dialog", { name: "Agent information request" })).toBeNull();
});

test("Given an information request, When the user declines it, Then the agent receives the decline and the form disappears", {
    timeout: 30_000,
}, async () => {
    const app = await requestInput();
    await app.user.click(getByRole(document.body, "button", { name: "Allow" }));
    const form = await app.waitForView(() => getByRole(document.body, "dialog", { name: "Agent information request" }));
    await app.user.click(getByRole(form, "button", { name: "Decline" }));
    await app.waitForView(() => expect(document.body.textContent).toContain("Input decline"));
    expect(queryByRole(document.body, "dialog", { name: "Agent information request" })).toBeNull();
});

test("Given a pending permission, When the user stops the turn, Then the turn ends without approving the action or requesting more input", {
    timeout: 30_000,
}, async () => {
    const app = await requestInput();
    const permission = getByRole(document.body, "alertdialog", { name: "Agent permission request" });
    await app.user.click(getByRole(permission, "button", { name: "Stop turn" }));
    await app.waitForView(() =>
        expect(queryByRole(document.body, "alertdialog", { name: "Agent permission request" })).toBeNull(),
    );
    await app.waitForView(() => expect(getByRole(document.body, "button", { name: "Send message" })).toBeDefined());
    expect(queryByRole(document.body, "dialog", { name: "Agent information request" })).toBeNull();
});

test("Given a permission decision changes the agent's workflow, When the user reviews and declines it, Then the original option meaning remains visible and is sent unchanged", {
    timeout: 30_000,
}, async () => {
    const app = await requestInput("request plan mode");
    const permission = getByRole(document.body, "alertdialog", { name: "Agent permission request" });
    expect(getByRole(permission, "button", { name: "Allow: Yes, enter plan mode" })).toBeDefined();
    await app.user.click(getByRole(permission, "button", { name: "Deny: No, start implementing now" }));
    await app.waitForView(() =>
        expect(document.body.textContent).toContain("Selected decision: No, start implementing now"),
    );
});

for (const [label, optionId] of [
    ["Allow for this session", "allow-session"],
    ["Deny for this session", "deny-session"],
] as const) {
    test(`Given session-scoped permission choices, When I select ${label}, Then the scope remains accurate and the original decision reaches the agent`, {
        timeout: 30_000,
    }, async () => {
        const app = await requestInput("request session permission");
        const permission = getByRole(document.body, "alertdialog", { name: "Agent permission request" });
        expect(permission.textContent).not.toContain("Always");
        await app.user.click(getByRole(permission, "button", { name: label }));
        await app.waitForView(() => expect(document.body.textContent).toContain(`Selected decision: ${optionId}`));
    });
}

test("Given a pending permission card, When the Computer drops and the retry notice appears, Then the notice joins the flow above the composer instead of covering the card's actions", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock("2026-10-30T08:00:00Z");
    const app = await createTestApp({
        connectAgent: true,
        agent: { harness: "interaction-test", label: "Interaction Agent" },
        clock,
    });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "request user input");
    const permission = await app.waitForView(() =>
        getByRole(document.body, "alertdialog", { name: "Agent permission request" }),
    );
    expect(getByRole(permission, "button", { name: "Allow" })).toBeDefined();
    if (app.daemon === null) {
        throw new Error("Expected the connected Computer");
    }
    await app.daemon.disconnect();
    await showReconnectNotice(app, clock);
    // A floating notice would sit exactly on the permission card and hide its
    // Allow/Deny row; an in-flow notice stacks above the composer instead.
    const notices = app.elementsByTestId(dataTestId.sessionReconnectNotice);
    expect(notices).toHaveLength(1);
    const slot = notices[0]?.closest("[data-notice-placement]");
    expect(slot?.getAttribute("data-notice-placement")).toBe("in-flow");
    expect(queryByRole(document.body, "alertdialog", { name: "Agent permission request" })).not.toBeNull();
    expect(getByRole(permission, "button", { name: "Allow" })).toBeDefined();
});

test("Given a background permission after the foreground turn ends, When the user reloads and approves it, Then the request is recovered and stays resolved after another reload", {
    timeout: 30_000,
}, async () => {
    const ready = Promise.withResolvers<() => Promise<void>>();
    const app = await createTestApp({
        connectAgent: true,
        agent: { harness: "interaction-test", label: "Interaction Agent", onBackgroundPermissionReady: ready.resolve },
    });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "request background permission");
    await app.waitForView(() => expect(document.body.textContent).toContain("Foreground work completed"));
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    await app.user.type(composer, "Unsent draft");
    await app.waitForView(() =>
        expect(getByRole(document.body, "button", { name: "Send message" })).toHaveProperty("disabled", false),
    );
    const response = (await ready.promise)();
    void response.catch(() => undefined);
    await app.waitForView(() => getByRole(document.body, "alertdialog", { name: "Agent permission request" }));
    const reloaded = await app.reload();
    const permission = await reloaded.waitForView(() =>
        getByRole(document.body, "alertdialog", { name: "Agent permission request" }),
    );
    expect(permission.textContent).toContain("echo verified");
    await reloaded.user.click(getByRole(permission, "button", { name: "Allow: Verify" }));
    await response;
    await reloaded.waitForView(() => expect(document.body.textContent).toContain("Background decision: allow-once"));
    expect(queryByRole(document.body, "alertdialog", { name: "Agent permission request" })).toBeNull();
    const settled = await reloaded.reload();
    await settled.user.type(await settled.queryElementByTestId(dataTestId.messageComposer), "Another unsent draft");
    await settled.waitForView(() =>
        expect(getByRole(document.body, "button", { name: "Send message" })).toHaveProperty("disabled", false),
    );
    expect(queryByRole(document.body, "alertdialog", { name: "Agent permission request" })).toBeNull();
});

test("Given the agent asks the user to open a page, When the user opens it, Then the conversation shows that it waits for the agent to confirm completion and still takes messages, also after a reload", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        connectAgent: true,
        agent: { harness: "interaction-test", label: "Interaction Agent" },
    });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "request account connection");
    const request = await app.waitForView(() =>
        getByRole(document.body, "dialog", { name: "Agent information request" }),
    );
    await app.user.click(getByRole(request, "button", { name: "Open page" }));

    const waiting = await app.waitForView(() => {
        const card = getByRole(document.body, "dialog", { name: "Agent information request" });
        expect(card.textContent).toContain("Waiting for the agent to confirm completion…");
        return card;
    });
    expect(getByRole(waiting, "link", { name: "Open again" })).toHaveProperty(
        "href",
        "https://accounts.example.test/connect",
    );
    expect(queryByRole(waiting, "status", { name: "Waiting for your answer" })).toBeNull();
    expect(getByRole(document.body, "status", { name: "Agent is working" })).toBeDefined();
    expect(await app.queryElementByTestId(dataTestId.messageComposer)).toHaveProperty("disabled", false);

    const reloaded = await app.reload();
    const recovered = await reloaded.waitForView(() => {
        const card = getByRole(document.body, "dialog", { name: "Agent information request" });
        expect(card.textContent).toContain("Waiting for the agent to confirm completion…");
        return card;
    });
    expect(getByRole(recovered, "link", { name: "Open again" })).toBeDefined();
    expect(await reloaded.queryElementByTestId(dataTestId.messageComposer)).toHaveProperty("disabled", false);
});
