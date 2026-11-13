import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import * as v from "valibot";
import { expect, test } from "vitest";
import { mortyReply } from "../../../tests/support/fake-daemon/scenarios.ts";
import { ControlledSetupRuntime } from "../../e2e/infra/setup-daemon.ts";
import worker from "../src/worker/application.ts";
import { createIdentityFixture } from "./support/identity-fixture.ts";

interface SetupModule {
    readonly runSetup: (
        args: readonly string[],
        host: {
            readonly state: string;
            readonly agentEnvironment: Readonly<Record<string, string>>;
            readonly signal: AbortSignal;
            readonly runtime: ControlledSetupRuntime;
            readonly clock: {
                readonly now: () => Date;
                readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
            };
            readonly emit: (event: Readonly<Record<string, unknown>>) => void;
        },
    ) => Promise<number>;
}

const setupModule = v.custom<SetupModule>(
    (value) =>
        typeof value === "object" && value !== null && "runSetup" in value && typeof value.runSetup === "function",
);
const identitySchema = v.object({
    computerToken: v.string(),
    computerId: v.string(),
});

// Stateful external admission port, explicitly replenished by the scenario; no real-time quota window.
class CreationBudget {
    remaining = 1;
    readonly limit = async () => ({ success: this.remaining-- > 0 });
}

test("Given setup and a lost creation response without a known computer, When setup retries across temporary failures, Then it saves a new computer pair and subsequently reuses that pair", {
    timeout: 60_000,
}, async () => {
    const setup = v.parse(setupModule, await import("../../cli/src/setup/setup.ts"));
    await using cleanup = new AsyncDisposableStack();
    const fixture = await createIdentityFixture();
    cleanup.defer(() => fixture.close());
    const directory = await realpath(await mkdtemp(join(tmpdir(), "morty-identity-admission-")));
    cleanup.defer(() => rm(directory, { recursive: true, force: true }));
    const state = join(directory, "state");
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const runtime = new ControlledSetupRuntime(
        { harness: "codex", agentName: "Codex", reply: mortyReply },
        "Admission Computer",
    );
    cleanup.defer(() => runtime.disconnect());
    const budget = new CreationBudget();
    let available = true;
    let loseResponse = true;
    let original: v.InferOutput<typeof identitySchema> | undefined;
    let completedIdentity: v.InferOutput<typeof identitySchema> | undefined;
    const creationKeys: string[] = [];
    const failures: unknown[] = [];
    let origin = "";
    // A real HTTP relay loses one successful response after the production Worker commits it.
    const server = createServer((incoming, outgoing) => {
        void (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of incoming) {
                chunks.push(Buffer.from(chunk));
            }
            const body = Buffer.concat(chunks);
            const headers = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) {
                if (typeof value === "string") {
                    headers.set(name, value);
                }
            }
            const request = new Request(new URL(incoming.url ?? "/", origin), {
                method: incoming.method ?? "GET",
                headers,
                ...(body.length === 0 ? {} : { body }),
                signal: AbortSignal.timeout(30_000),
            });
            const creation = new URL(request.url).pathname === "/morty/api/v1/computers";
            if (creation) {
                creationKeys.push(
                    v.parse(v.object({ creationKey: v.string() }), JSON.parse(body.toString())).creationKey,
                );
            }
            const response = await worker.fetch(request, {
                ...fixture.environment(origin),
                ANONYMOUS_CREATION_LIMITER: available ? budget : undefined,
            });
            const bytes = await response.arrayBuffer();
            if (creation && response.status === 201 && loseResponse) {
                original = v.parse(identitySchema, JSON.parse(Buffer.from(bytes).toString()));
                loseResponse = false;
                outgoing.destroy();
                return;
            }
            if (creation && response.status === 201) {
                completedIdentity = v.parse(identitySchema, JSON.parse(Buffer.from(bytes).toString()));
            }
            outgoing.writeHead(response.status, Object.fromEntries(response.headers));
            outgoing.end(Buffer.from(bytes));
        })().catch((cause) => {
            failures.push(cause);
            outgoing.destroy();
        });
    });
    // The consolidated origin carries Computer WebSockets as well as setup HTTP requests.
    const sockets = new Set<Duplex>();
    server.on("upgrade", (incoming, socket, head) => {
        sockets.add(socket);
        const upstream = httpRequest(new URL(incoming.url ?? "/", fixture.origin), { headers: incoming.headers });
        upstream.on("upgrade", (response, remote, remoteHead) => {
            sockets.add(remote);
            socket.write(
                `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${response.rawHeaders.reduce((lines, value, index) => lines + value + (index % 2 === 0 ? ": " : "\r\n"), "")}\r\n`,
            );
            if (head.length > 0) {
                remote.write(head);
            }
            if (remoteHead.length > 0) {
                socket.write(remoteHead);
            }
            remote.pipe(socket).pipe(remote);
            remote.on("error", () => socket.destroy());
            socket.on("error", () => remote.destroy());
            remote.on("close", () => {
                sockets.delete(remote);
                socket.destroy();
            });
            socket.on("close", () => {
                sockets.delete(socket);
                remote.destroy();
            });
        });
        upstream.on("error", () => socket.destroy());
        socket.on("error", () => upstream.destroy());
        upstream.end();
    });
    cleanup.defer(async () => {
        for (const socket of sockets) {
            socket.destroy();
        }
        server.closeAllConnections();
        if (server.listening) {
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Missing admission HTTP address");
    }
    origin = `http://127.0.0.1:${address.port}`;
    await fixture.changeAppOrigin(origin);
    let time = Date.parse("2026-10-30T00:00:00Z");
    const run = async () => {
        const events: Readonly<Record<string, unknown>>[] = [];
        const code = await setup.runSetup(
            [
                "setup",
                "--base-url",
                origin,
                "--cwd",
                workspace,
                "--harness",
                "codex",
                "--session-id",
                "native-admission",
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
        return { code, events };
    };
    const configuration = async () =>
        v.parse(
            v.object({ identity: v.record(v.string(), v.unknown()) }),
            JSON.parse(await readFile(join(state, "config.json"), "utf8")),
        ).identity;
    {
        expect((await run()).code).toBe(1);
        const pending = await configuration();
        expect(pending).toEqual({ kind: "creating", creation_key: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u) });
        expect(original).toBeDefined();
        const limited = await run();
        expect(limited.code).toBe(1);
        expect(limited.events.at(-1)).toMatchObject({ error: { code: "IDENTITY_CREATION_RATE_LIMITED" } });
        expect(await configuration()).toEqual(pending);
        available = false;
        const unavailable = await run();
        expect(unavailable.code).toBe(1);
        expect(unavailable.events.at(-1)).toMatchObject({ error: { code: "IDENTITY_CREATION_UNAVAILABLE" } });
        expect(await configuration()).toEqual(pending);
        available = true;
        budget.remaining = 1;
        const completed = await run();
        expect(completed.code, JSON.stringify(completed.events)).toBe(0);
        const identity = v.parse(identitySchema, completedIdentity);
        expect(identity.computerId).not.toBe(v.parse(identitySchema, original).computerId);
        expect(completed.events.at(-1)).toMatchObject({ status: "ready", workspace, computerId: identity.computerId });
        expect(await configuration()).toMatchObject({
            kind: "ready",
            computer_token: identity.computerToken,
            computer_id: identity.computerId,
        });
        expect(new Set(creationKeys)).toEqual(new Set([pending["creation_key"]]));
        const session = await fetch(`${origin}/morty/api/v1/computers/${identity.computerId}/session`, {
            headers: { authorization: `Bearer ${identity.computerToken}` },
        });
        expect(session.status).toBe(200);
        expect(await session.json()).toMatchObject({ computerId: identity.computerId });
        const creationCount = creationKeys.length;
        expect((await run()).code).toBe(0);
        expect(creationKeys).toHaveLength(creationCount);
        expect(await configuration()).toMatchObject({ computer_id: identity.computerId });
        expect(failures).toEqual([]);
    }
});
