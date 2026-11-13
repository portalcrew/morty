import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";
import { ClaudeFixture } from "../cli/tests/support/agents/claude.ts";
import { FakeAnthropicProvider } from "../cli/tests/support/llm/anthropic.ts";

const execute = promisify(execFile);
const interrupted = new AbortController();
process.once("SIGINT", () => interrupted.abort());
process.once("SIGTERM", () => interrupted.abort());
const signal = AbortSignal.any([interrupted.signal, AbortSignal.timeout(12 * 60_000)]);
const [origin, archiveArgument, label] = process.argv.slice(2);
assert.ok(origin && archiveArgument && /^[a-z0-9-]+$/.test(label));
const output = resolve(".release/acceptance");
await mkdir(output, { recursive: true });
const archive = resolve(archiveArgument);
const archiveSha256 = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
const root = await mkdtemp(join(output, ".private-release-"));
await chmod(root, 0o700);
const state = join(root, "state");
const workspace = join(root, "workspace");
await mkdir(workspace);
const answer = "MORTY_LAUNCH_ACCEPTANCE_REPLY";
let imageReceived = false;
await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", answer, {
    beforeFirstText: async (_scenario, _signal, payload) => {
        imageReceived ||= payload?.includes('"type":"image"') ?? false;
    },
});
const reply = provider.responseFor("Plain acceptance reply");
await using agent = await ClaudeFixture.create(provider);
const environment = {
    ...process.env,
    ...agent.environment,
    MORTY_STATE_DIRECTORY: state,
    npm_config_cache: join(root, "npm-cache"),
    npm_config_userconfig: join(root, "npmrc"),
};
for (const key of ["CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID"]) {
    delete environment[key];
}
await writeFile(environment.npm_config_userconfig, "", { mode: 0o600 });
const run = (command, args, extra = {}) =>
    execute(command, args, {
        cwd: workspace,
        env: environment,
        signal,
        timeout: 360_000,
        maxBuffer: 12 * 1024 * 1024,
        ...extra,
    });
const entry = join(root, "package/node_modules/@morty-build/cli/dist/cli.js");
const cli = (...args) => run(process.execPath, [entry, ...args]);
let packageInstalled = false;
let browser;
let page;
let identity;
let complete = false;
let cleanupComplete = false;
const events = [];
const receipt = { origin, archiveSha256, agent: "Claude Code 2.1.273", provider: "controlled Anthropic HTTP", label };
const stage = (name) => {
    events.push(name);
    console.log(JSON.stringify({ stage: name }));
};
try {
    stage("install-exact-archive");
    await run("npm", [
        "install",
        "--prefix",
        join(root, "package"),
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        archive,
    ]);
    packageInstalled = true;
    const metadata = JSON.parse(
        await readFile(join(root, "package/node_modules/@morty-build/cli/package.json"), "utf8"),
    );
    receipt.version = metadata.version;
    stage("create-real-native-session");
    const session = randomUUID();
    const seeded = await run(agent.executable, [
        "--print",
        "--output-format",
        "json",
        "--session-id",
        session,
        "--model",
        provider.model,
        "Reply with the acceptance greeting.",
    ]);
    assert.ok(seeded.stdout.includes(answer));
    stage("fresh-setup-and-pairing");
    let setupOutput;
    try {
        setupOutput = await cli(
            "setup",
            "--base-url",
            origin,
            "--cwd",
            workspace,
            "--harness",
            "claude",
            "--session-id",
            session,
        );
    } finally {
        try {
            identity = JSON.parse(await readFile(join(state, "config.json"), "utf8")).identity;
            receipt.computerId = identity.computer_id;
            await writeFile(
                join(output, `${label}-owned-computer.json`),
                `${JSON.stringify({ computerId: identity.computer_id, origin })}\n`,
            );
        } catch {
            /* A preflight failure may leave no identity. */
        }
    }
    const setupEvents = setupOutput.stdout.split("\n").flatMap((line) => {
        try {
            return [JSON.parse(line)];
        } catch {
            return [];
        }
    });
    const ready = setupEvents.find((event) => event.status === "ready");
    assert.ok(ready?.url, "Setup did not report ready");
    assert.match((await cli("status")).stdout, new RegExp(`Daemon: ${metadata.version.replaceAll(".", "\\.")}`));
    stage("browser-native-history");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    page = await context.newPage();
    page.setDefaultTimeout(90_000);
    await page.goto(ready.url);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText(reply, { exact: true })).toHaveCount(1, { timeout: 90_000 });
    stage("browser-attachment-and-reply");
    await page.getByLabel("Choose attachments").setInputFiles({
        name: "launch.png",
        mimeType: "image/png",
        buffer: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
            "base64",
        ),
    });
    await page
        .getByRole("textbox", { name: "Message", exact: true })
        .fill("Inspect the attached launch image and reply.");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByText(reply, { exact: true })).toHaveCount(2, { timeout: 90_000 });
    await expect(page.getByRole("button", { name: "Stop agent output", exact: true })).toBeHidden({ timeout: 90_000 });
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible({ timeout: 90_000 });
    assert.ok(imageReceived, "The real Agent did not deliver the attachment to its model provider");
    await expect(page.getByRole("img", { name: "Your attachment", exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole("img", { name: "Your attachment", exact: true })).toHaveJSProperty("naturalWidth", 1);
    receipt.browserAttachmentDisplayed = true;
    await page.screenshot({ path: join(output, `${label}-desktop.png`), fullPage: true });
    stage("daemon-restart-and-history");
    await cli("stop");
    assert.match((await cli("status")).stdout, /Daemon: not running/);
    await cli("start");
    await page.reload();
    await expect(page.getByText(reply, { exact: true })).toHaveCount(2, { timeout: 90_000 });
    await expect(page.getByRole("button", { name: "Stop agent output", exact: true })).toBeHidden({ timeout: 90_000 });
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible({ timeout: 90_000 });
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Continue after the Computer restart.");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByText(reply, { exact: true })).toHaveCount(3, { timeout: 90_000 });
    await expect(page.getByRole("button", { name: "Stop agent output", exact: true })).toBeHidden({ timeout: 90_000 });
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible({ timeout: 90_000 });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("img", { name: "Your attachment", exact: true })).toBeAttached({ timeout: 90_000 });
    await expect(page.getByRole("img", { name: "Your attachment", exact: true })).toHaveJSProperty("naturalWidth", 1);
    receipt.recoveredAttachmentDisplayed = true;
    await page.screenshot({ path: join(output, `${label}-mobile.png`), fullPage: true });
    complete = true;
} catch (error) {
    if (page && !page.url().includes("#code=")) {
        await page.screenshot({ path: join(output, `${label}-failure.png`), fullPage: true }).catch(() => {});
    }
    // Keep private process output and credentials out of the public acceptance log.
    await writeFile(
        join(root, "failure.txt"),
        `${String(error?.stack ?? error)}\n${String(error?.stderr ?? "")}\n${String(error?.stdout ?? "")}`,
        { mode: 0o600 },
    );
    console.error(
        JSON.stringify({ failedStage: events.at(-1), errorName: error?.name, errorCode: error?.code ?? null }),
    );
    process.exitCode = 1;
} finally {
    stage("cleanup");
    await browser?.close().catch(() => {});
    const cleanupSignal = AbortSignal.timeout(180_000);
    const cleanupCli = (...args) => run(process.execPath, [entry, ...args], { signal: cleanupSignal });
    let localClean = !packageInstalled;
    if (packageInstalled) {
        try {
            await cleanupCli("stop");
            const status = (await cleanupCli("status")).stdout;
            localClean = status.includes("Daemon: not running");
        } catch {
            localClean = false;
        }
    }
    receipt.localCleanup = localClean;
    if (identity?.computer_id && identity?.computer_token) {
        // Revoking all access replaces the local credential; the replacement is then retired too.
        const successor = `morty_computer_v1_${randomBytes(32).toString("base64url")}`;
        const call = (path, method, token, body) =>
            fetch(new URL(`/morty/api/v1/computers/${encodeURIComponent(identity.computer_id)}${path}`, origin), {
                method,
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: AbortSignal.timeout(30_000),
            });
        const shares = await call("/identity/revoke-all-access", "POST", identity.computer_token, { successor });
        const sharedResult = shares.status === 200 ? await shares.json() : null;
        const sharesRevoked =
            shares.status === 401 || (shares.status === 200 && sharedResult?.status === "access_revoked");
        const remaining = shares.status === 200 ? successor : identity.computer_token;
        const local = sharesRevoked ? await call("/identity/local-credential", "DELETE", remaining) : null;
        const rejected = local
            ? [await call("/session", "GET", identity.computer_token), await call("/session", "GET", successor)]
            : null;
        cleanupComplete =
            sharesRevoked &&
            [204, 401].includes(local?.status) &&
            rejected?.every((response) => response.status === 401) === true;
        receipt.credentialCleanup = {
            shares: shares.status,
            sharesResult: sharedResult?.status,
            local: local?.status,
            subsequentAccess: rejected?.map((response) => response.status),
        };
    } else {
        cleanupComplete = true;
    }
    cleanupComplete &&= localClean;
    receipt.complete = complete && cleanupComplete;
    receipt.stages = events;
    await writeFile(join(output, `${label}-verification.json`), `${JSON.stringify(receipt, null, 2)}\n`);
    if (complete && cleanupComplete) {
        await rm(root, { force: true, recursive: true });
    } else {
        console.error(JSON.stringify({ retainedPrivateDiagnosticDirectory: root }));
    }
    if (!receipt.complete) {
        process.exitCode = 1;
    }
    console.log(
        JSON.stringify({
            complete: receipt.complete,
            version: receipt.version,
            archiveSha256,
            credentialCleanup: receipt.credentialCleanup,
        }),
    );
}
