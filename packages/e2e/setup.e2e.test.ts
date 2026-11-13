import { mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { dataTestId } from "../web/src/data-testid.ts";
import { expect, test } from "./infra/test.ts";

/** How the Computer shows a directory: under the user's home directory as `~/…`, elsewhere in full. */
function directoryLabel(path: string): string {
    const suffix = relative(homedir(), path);
    return suffix === "" ? "~" : !isAbsolute(suffix) && !suffix.startsWith("..") ? `~/${suffix}` : path;
}

test("Given a saved setup handoff, When its Computer reconnects, Then setup returns a concise QR image reference", async ({
    runtime,
}) => {
    const original = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    await runtime.disconnectRuntime();
    const connected = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    const statuses = connected.events.map((event) => event["status"]);

    expect(original.events).toContainEqual(expect.objectContaining({ status: "ready", computer: "created" }));
    expect(connected.events).toContainEqual(expect.objectContaining({ status: "ready", computer: "reused" }));
    expect(connected.computerId).toBe(original.computerId);
    expect(statuses).not.toContain("prepared");
    expect(statuses).toEqual(
        expect.arrayContaining(["computer_reused", "computer_paired", "computer_online", "binding_activated"]),
    );
    expect(statuses.indexOf("computer_reused")).toBeLessThan(statuses.indexOf("computer_paired"));
    expect(statuses.indexOf("computer_paired")).toBeLessThan(statuses.indexOf("computer_online"));
    expect(statuses.indexOf("computer_online")).toBeLessThan(statuses.indexOf("binding_activated"));
    expect(connected.configuration).toHaveProperty("pairing", { kind: "none" });
    expect(connected.configuration).not.toHaveProperty("pairing_key");
    expect(connected.configuration).not.toHaveProperty("expected_computer_id");
    expect(connected.configuration).not.toHaveProperty("computer_process");
    const ready = connected.events.find((event) => event["status"] === "ready");
    expect(ready).not.toHaveProperty("qrDataUrl");
    expect(ready).not.toHaveProperty("qrTextPath");
    if (connected.qrPath === null) {
        throw new Error("Expected setup to return a QR image path");
    }
    expect(dirname(connected.qrPath)).toBe(tmpdir());
    expect(connected.qrPath).toMatch(/morty-handoff-[0-9a-f-]+\.png$/u);
});

test("Given the agent's shell exposes its Claude Code session, When it follows the published setup instructions, Then the handoff link continues that session", async ({
    runtime,
}) => {
    const connected = await runtime.followInstructions("/setup.md", "claude-shell-session");

    expect(new URL(connected.url).searchParams.get("sessionId")).toBe("claude-shell-session");
    expect(connected.events).not.toContainEqual(expect.objectContaining({ status: "session_id_mismatch" }));
});

test("Given a saved Computer the manager no longer manages, When the user approves its replacement, Then setup pairs a fresh Computer", async ({
    runtime,
}) => {
    const original = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    await runtime.forgetRuntimeConnections();
    const connected = await runtime.followInstructions(
        "/setup.md",
        "setup-reconnect-session",
        undefined,
        undefined,
        original.identity.computerId,
    );

    expect(connected.events).not.toContainEqual(expect.objectContaining({ status: "computer_reused" }));
    expect(connected.identity.computerId).not.toBe(original.identity.computerId);
    expect(connected.computerId).not.toBe(original.computerId);
    const statuses = connected.events.map((event) => event["status"]);
    expect(statuses).toContain("prepared");
    // The agent reads this to tell the user that links from the replaced Computer stopped working.
    expect(connected.events).toContainEqual(expect.objectContaining({ status: "ready", computer: "replaced" }));
});

test("Given a browser opened the saved Computer's link, When the user approves replacing it, Then earlier access ends and the new link works in the same tab", async ({
    runtime,
}) => {
    const original = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    const { page } = runtime;
    await page.goto(original.url);
    await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
    const previousToken = original.configuration["computer_token"];
    await runtime.forgetRuntimeConnections();

    const connected = await runtime.followInstructions(
        "/setup.md",
        "setup-reconnect-session",
        undefined,
        undefined,
        original.identity.computerId,
    );

    expect(connected.identity.computerId).not.toBe(original.identity.computerId);
    expect(connected.configuration["replacement"]).toEqual({ kind: "unchanged" });
    const session = await page.request.get(
        `${runtime.origin}/morty/api/v1/computers/${original.identity.computerId}/session`,
        { headers: { authorization: `Bearer ${String(previousToken)}` } },
    );
    expect(session.status()).toBe(401);
    // Observe the open page: reloading after it detects revocation dismisses this one-time notice.
    await expect(page.getByRole("status")).toContainText("Current access ended");
    await page.goto(original.url);
    await expect(page.getByRole("heading", { name: "This link is no longer available" })).toBeVisible();
    // The new link differs only after "#", so the browser keeps the page that showed the previous one.
    await page.goto(connected.url);
    await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
});

test("Given a saved Computer and another same-App connection, When its Runtime reconnects, Then setup reuses the saved Computer", async ({
    runtime,
}) => {
    await runtime.openChat();
    await runtime.connectUnrelatedRuntime();
    const original = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    await runtime.disconnectRuntime();

    const connected = await runtime.followInstructions("/setup.md", "setup-reconnect-session", 5_000);

    expect(connected.computerId).toBe(original.computerId);
    expect(connected.events).toEqual(
        expect.arrayContaining([
            expect.objectContaining({ status: "computer_reused" }),
            expect.objectContaining({ status: "computer_online" }),
            expect.objectContaining({ status: "ready" }),
        ]),
    );
});

test("Given a healthy connected Computer, When setup runs again, Then it reuses the live connection and hands off to Chat", async ({
    runtime,
}) => {
    const original = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    const connected = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    expect(connected.computerId).toBe(original.computerId);
    expect(connected.events).toContainEqual(expect.objectContaining({ status: "computer_already_online" }));
    expect(connected.events).not.toContainEqual(expect.objectContaining({ status: "runtime_started" }));
    await runtime.page.goto(connected.url);
    await expect(runtime.page.getByRole("textbox", { name: "Message" })).toBeEnabled();
    await runtime.page.getByRole("textbox", { name: "Message" }).fill("Hello after repeated setup");
    await runtime.page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(runtime.page.getByRole("article", { name: "Agent response" })).toContainText(
        "Hello after repeated setup",
    );
});

test("Given a native session handoff, When the browser opens it, Then the original session opens directly in Chat", async ({
    runtime,
}) => {
    const connected = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    const { page } = runtime;
    await page.goto(connected.url);
    await expect(page).toHaveURL((url) => url.pathname === "/chat" && url.searchParams.has("sessionId"));
    await expect(page.getByRole("main", { name: "Chat" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Fork session", exact: true })).toHaveCount(0);
});

test("Given a successful native session handoff, When the browser opens the retained link again, Then it reopens the same session", async ({
    runtime,
}) => {
    const connected = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    const { page } = runtime;
    await page.goto(connected.url);
    await expect(page).toHaveURL((url) => url.pathname === "/chat" && url.searchParams.has("sessionId"));
    await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
    const sessionUrl = page.url();
    await page.goto(connected.url);
    await expect(page).toHaveURL(sessionUrl);
    await expect(page.getByRole("main", { name: "Chat" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
});

test("Given setup was previously paired in another directory, When a new project handoff opens, Then new sessions use the reported project directory", async ({
    runtime,
}, testInfo) => {
    const original = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    const workspace = join(
        original.workspace,
        "project with spaces \u00e9",
        ...Array.from({ length: 4 }, () => "\u00e9".repeat(90)),
    );
    await mkdir(workspace, { recursive: true });
    const connected = await runtime.followInstructions("/setup.md", "setup-reconnect-session", 5000, workspace);
    expect(connected.workspace).toBe(workspace);
    await runtime.page.goto(connected.url);
    await expect(runtime.page.getByRole("textbox", { name: "Message" })).toBeEnabled();
    await runtime.page.reload();
    await runtime.page.getByRole("button", { name: "New Session", exact: true }).click();
    await expect(runtime.page.getByTestId(dataTestId.workingDirectory)).toContainText("\u00e9".repeat(90));
    await runtime.page.getByRole("textbox", { name: "Message" }).fill("Verify the setup project directory");
    await runtime.page.getByRole("button", { name: "Send message" }).click();
    await expect(runtime.page.getByRole("article", { name: "Agent response" })).toContainText(
        "Verify the setup project directory",
    );
    // Execution details live in the computer menu.
    await runtime.page.getByRole("button", { name: /^Switch computer, / }).click();
    await runtime.page.getByRole("menuitem", { name: /View execution details/ }).click();
    const details = runtime.page.getByRole("dialog", { name: "Execution details", exact: true });
    await expect(details.getByTestId(dataTestId.executionDirectory)).toHaveText(directoryLabel(workspace));
    await runtime.page.screenshot({ path: testInfo.outputPath("long-workspace-handoff.png"), fullPage: true });
});
