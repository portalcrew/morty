import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createResponseLossProxy } from "@morty-build/relay-test-support/response-loss-proxy";
import * as v from "valibot";
import { expect, test } from "vitest";
import { mortyReply } from "../../../tests/support/fake-daemon/scenarios.ts";
import { runSetup } from "../../cli/src/setup/setup.ts";
import { ControlledSetupRuntime } from "../../e2e/infra/setup-daemon.ts";
import worker from "../src/worker/application.ts";
import { createIdentityFixture } from "./support/identity-fixture.ts";

test.each(["current", "another service origin", "retired configuration"] as const)(
    "Given %s, When setup runs again, Then it continues the saved identity's Computer or refuses without rewriting the saved state",
    {
        timeout: 60_000,
    },
    async (stateKind) => {
        await using cleanup = new AsyncDisposableStack();
        const fixture = await createIdentityFixture({
            listenOnLoopback: true,
            workerEntryPoint: fileURLToPath(new URL("./support/credential-storage-worker.ts", import.meta.url)),
        });
        cleanup.defer(() => fixture.close());
        const directory = await realpath(await mkdtemp(join(tmpdir(), "morty-setup-computer-")));
        cleanup.defer(() => rm(directory, { recursive: true, force: true }));
        const state = join(directory, "state");
        const workspace = join(directory, "workspace");
        await mkdir(workspace);
        const runtime = new ControlledSetupRuntime(
            { harness: "codex", agentName: "Codex", reply: mortyReply },
            "Laptop",
        );
        cleanup.defer(() => runtime.disconnect());
        let time = Date.parse("2026-10-30T00:00:00Z");
        const run = async (expectedCode = 0, origin = fixture.origin) => {
            const events: Readonly<Record<string, unknown>>[] = [];
            const code = await runSetup(
                [
                    "setup",
                    "--base-url",
                    origin,
                    "--cwd",
                    workspace,
                    "--harness",
                    "codex",
                    "--session-id",
                    "native-computer",
                ],
                {
                    state,
                    runtime,
                    agentEnvironment: {},
                    signal: AbortSignal.timeout(40_000),
                    clock: {
                        now: () => new Date(time),
                        wait: async (milliseconds, signal) => {
                            signal.throwIfAborted();
                            time += milliseconds;
                        },
                    },
                    emit: (event) => events.push(event),
                },
            );
            expect(code, JSON.stringify(events)).toBe(expectedCode);
            if (expectedCode !== 0) {
                return events.at(-1);
            }
            return v.parse(
                v.object({ status: v.literal("ready"), computerId: v.string(), url: v.string() }),
                events.at(-1),
            );
        };
        const configurationPath = join(state, "config.json");
        const savedIdentity = v.object({
            base_url: v.string(),
            identity: v.object({ computer_token: v.string(), computer_id: v.string() }),
        });

        const first = v.parse(v.object({ computerId: v.string() }), await run());
        const saved = v.parse(savedIdentity, JSON.parse(await readFile(configurationPath, "utf8")));
        const identity = saved.identity;
        expect(identity.computer_id).toBe(first.computerId);
        if (stateKind === "retired configuration") {
            // The representation setup wrote before its saved state was versioned.
            await writeFile(configurationPath, JSON.stringify({ base_url: saved.base_url, ...identity }));
        }
        if (stateKind !== "current") {
            const original = await readFile(configurationPath, "utf8");
            // The same service reached through another origin is still another service to the saved identity.
            const requested = new URL(fixture.origin);
            requested.hostname = "localhost";
            const outcome = await run(1, stateKind === "another service origin" ? requested.origin : fixture.origin);
            expect(outcome).toMatchObject({
                error:
                    stateKind === "another service origin"
                        ? {
                              code: "SAVED_IDENTITY_ORIGIN_MISMATCH",
                              savedIdentity: { savedBaseUrl: fixture.origin, requestedBaseUrl: requested.origin },
                          }
                        : { code: "INVALID_CONFIGURATION" },
            });
            expect(await readFile(configurationPath, "utf8")).toBe(original);
            if (stateKind !== "another service origin") {
                return;
            }
        }

        const ready = v.parse(v.object({ computerId: v.string(), url: v.string() }), await run());
        const redeemed = await worker.fetch(
            new Request(`${fixture.origin}/morty/api/v1/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code: new URLSearchParams(new URL(ready.url).hash.slice(1)).get("code") }),
            }),
            fixture.environment(fixture.origin),
        );

        expect(ready.computerId).toBe(first.computerId);
        expect(redeemed.status).toBe(200);
        expect(await redeemed.json()).toMatchObject({ computerId: first.computerId });
        expect(v.parse(savedIdentity, JSON.parse(await readFile(configurationPath, "utf8")))).toMatchObject({
            base_url: fixture.origin,
            identity,
        });
    },
);

test("Given the answer to setup's Computer pairing is lost, When setup runs again, Then the Computer uses that same pairing", {
    timeout: 60_000,
}, async () => {
    await using cleanup = new AsyncDisposableStack();
    const fixture = await createIdentityFixture({
        listenOnLoopback: true,
        workerEntryPoint: fileURLToPath(new URL("./support/credential-storage-worker.ts", import.meta.url)),
    });
    cleanup.defer(() => fixture.close());
    const network = await createResponseLossProxy(fixture.origin);
    cleanup.defer(() => network.close());
    // Setup reaches the Worker through a network that can lose one answer; the Worker serves that origin.
    await fixture.changeAppOrigin(network.origin);
    const directory = await realpath(await mkdtemp(join(tmpdir(), "morty-setup-pairing-")));
    cleanup.defer(() => rm(directory, { recursive: true, force: true }));
    const state = join(directory, "state");
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const runtime = new ControlledSetupRuntime({ harness: "codex", agentName: "Codex", reply: mortyReply }, "Laptop");
    cleanup.defer(() => runtime.disconnect());
    let time = Date.parse("2026-10-30T00:00:00Z");
    const run = async () =>
        await runSetup(
            [
                "setup",
                "--base-url",
                network.origin,
                "--cwd",
                workspace,
                "--harness",
                "codex",
                "--session-id",
                "native-pairing",
            ],
            {
                state,
                runtime,
                agentEnvironment: {},
                signal: AbortSignal.timeout(40_000),
                clock: {
                    now: () => new Date(time),
                    wait: async (milliseconds, signal) => {
                        signal.throwIfAborted();
                        time += milliseconds;
                    },
                },
                emit: () => undefined,
            },
        );

    const lost = network.interruptNextComputerPairing();
    expect(await run()).not.toBe(0);
    const pairing = await lost;
    expect(pairing.status).toBe(201);
    const lostPairing = v.parse(v.object({ computerId: v.string() }), JSON.parse(pairing.body));
    const pairedComputer = lostPairing.computerId;

    expect(await run()).toBe(0);
    const saved = v.parse(
        v.object({ identity: v.object({ computer_token: v.string(), computer_id: v.string() }) }),
        JSON.parse(await readFile(join(state, "config.json"), "utf8")),
    );
    const computer = await fetch(
        `${fixture.origin}/morty/api/v1/computers/${saved.identity.computer_id}/pairing-state`,
        {
            headers: { authorization: `Bearer ${saved.identity.computer_token}` },
        },
    );
    const actual: unknown = await computer.json();
    const original = await fetch(`${fixture.origin}/morty/api/v1/computers/${saved.identity.computer_id}/pairing`, {
        headers: { authorization: `Bearer ${saved.identity.computer_token}` },
    });
    expect(original.status).toBe(200);
    const originalStatus = v.parse(v.object({ status: v.string() }), await original.json()).status;
    expect(originalStatus).toBe("paired");
    expect(actual).toEqual({ computerPairing: "paired" });
    expect(saved.identity.computer_id).toBe(pairedComputer);
});

test("Given a computer whose Runtime Morty revoked, When setup runs again, Then it pairs the same Computer with a new Runtime and keeps the computer's identity", {
    timeout: 60_000,
}, async () => {
    await using cleanup = new AsyncDisposableStack();
    const fixture = await createIdentityFixture({
        listenOnLoopback: true,
        workerEntryPoint: fileURLToPath(new URL("./support/credential-storage-worker.ts", import.meta.url)),
    });
    cleanup.defer(() => fixture.close());
    const directory = await realpath(await mkdtemp(join(tmpdir(), "morty-setup-revoked-")));
    cleanup.defer(() => rm(directory, { recursive: true, force: true }));
    const state = join(directory, "state");
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const runtime = new ControlledSetupRuntime({ harness: "codex", agentName: "Codex", reply: mortyReply }, "Laptop");
    cleanup.defer(() => runtime.disconnect());
    let time = Date.parse("2026-11-09T00:00:00Z");
    const run = async () => {
        const events: Readonly<Record<string, unknown>>[] = [];
        const code = await runSetup(
            [
                "setup",
                "--base-url",
                fixture.origin,
                "--cwd",
                workspace,
                "--harness",
                "codex",
                "--session-id",
                "native-revoked",
            ],
            {
                state,
                runtime,
                agentEnvironment: {},
                signal: AbortSignal.timeout(40_000),
                clock: {
                    now: () => new Date(time),
                    wait: async (milliseconds, signal) => {
                        signal.throwIfAborted();
                        time += milliseconds;
                    },
                },
                emit: (event) => events.push(event),
            },
        );
        expect(code, JSON.stringify(events)).toBe(0);
        return {
            events,
            ready: v.parse(
                v.object({ status: v.literal("ready"), computerId: v.string(), url: v.string() }),
                events.at(-1),
            ),
        };
    };
    const savedIdentity = v.object({
        identity: v.object({ computer_token: v.string(), computer_id: v.string() }),
    });
    const computerState = async () => {
        const { identity } = v.parse(savedIdentity, JSON.parse(await readFile(join(state, "config.json"), "utf8")));
        const response = await worker.fetch(
            new Request(`${fixture.origin}/morty/api/v1/computers/${identity.computer_id}/pairing-state`, {
                headers: { authorization: `Bearer ${identity.computer_token}` },
            }),
            fixture.environment(fixture.origin),
        );
        expect(response.status).toBe(200);
        return {
            identity,
            computerPairing: v.parse(v.object({ computerPairing: v.string() }), await response.json()).computerPairing,
        };
    };
    const first = await run();
    const before = await computerState();
    await fixture.revokeComputer(before.identity.computer_id);
    const revokedWorkspace = await fixture.relayRequest(
        new Request(`${fixture.origin}/morty/api/v1/computers/${before.identity.computer_id}/workspace`, {
            method: "POST",
            headers: { authorization: `Bearer ${before.identity.computer_token}` },
        }),
    );
    expect(revokedWorkspace.status).toBe(401);
    expect(await revokedWorkspace.json()).toMatchObject({ error: { code: "computer_revoked" } });

    expect((await computerState()).computerPairing).toBe("revoked");

    const again = await run();
    const after = await computerState();

    expect(again.events).toContainEqual(
        expect.objectContaining({ status: "computer_revoked", computerId: before.identity.computer_id }),
    );
    expect(again.ready.computerId).toBe(first.ready.computerId);
    const originalAccess = new URLSearchParams(new URL(first.ready.url).hash.slice(1)).get("e2e");
    expect(originalAccess).not.toBeNull();
    expect(new URLSearchParams(new URL(again.ready.url).hash.slice(1)).get("e2e")).toBe(originalAccess);
    expect(after.identity).toEqual(before.identity);
    expect(after.computerPairing).toBe("paired");
});
