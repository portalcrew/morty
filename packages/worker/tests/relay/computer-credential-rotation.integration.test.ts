import { abortAllDurableObjects } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
    COMPUTER_SUCCESSOR_CREDENTIAL_HEADER,
    computerCredentialSuccessor,
    MORTY_API_PREFIX,
} from "@morty-build/client/protocol";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestMortyRelayApp } from "../../../relay-test-support/src/app.ts";
import { RelayAuthenticationConfiguration } from "../../src/contracts/relay/computer-management.ts";
import type { RelayBindings } from "../../src/contracts/relay-bindings.ts";
import { createOwner, ownerRequest } from "./owner-fixture.ts";

const relayOrigin = "https://relay.test";

function bindings(): RelayBindings {
    return {
        COMPUTER_RELAY: env.COMPUTER_RELAY,
        MORTY_SESSION_SIGNING_SECRET: env.MORTY_SESSION_SIGNING_SECRET,
    };
}

function text(value: Readonly<Record<string, unknown>>, name: string): string {
    const field = value[name];
    if (typeof field !== "string" || field.length === 0) {
        throw new Error(`Expected ${name}`);
    }
    return field;
}

async function responseJson(response: Response, status: number): Promise<Readonly<Record<string, unknown>>> {
    const body: unknown = await response.json();
    expect(response.status).toBe(status);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new Error("Expected a response object");
    }
    return Object.fromEntries(Object.entries(body));
}

/** Pairs a Runtime through the public pairing API and returns how its daemon connects. */
async function pairedComputer(name: string) {
    const worker = createTestMortyRelayApp(new RelayAuthenticationConfiguration());
    const environment = bindings();
    const owner = await createOwner();
    const headers = new Headers({ authorization: `Bearer ${owner.token}`, "content-type": "application/json" });
    const pairing = await responseJson(
        await ownerRequest(
            new Request(`${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${owner.computerId}/pairing`, {
                body: JSON.stringify({ idempotencyKey: name }),
                headers,
                method: "POST",
            }),
        ),
        201,
    );
    const claimed = await responseJson(
        await worker.fetch(
            new Request(
                `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${text(pairing, "computerId")}/pairing/redeem`,
                {
                    body: JSON.stringify({
                        agents: [],
                        computerName: "Owner laptop",
                        pairingCode: text(pairing, "pairingCode"),
                        workspaceName: "workspace",
                    }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                },
            ),
            environment,
        ),
        200,
    );
    return {
        credential: text(claimed, "computerCredential"),
        connect: (current: string, successor: string) =>
            worker.fetch(
                new Request(`${relayOrigin}${MORTY_API_PREFIX}/v1/computers/connect`, {
                    headers: {
                        authorization: `Bearer ${current}`,
                        [COMPUTER_SUCCESSOR_CREDENTIAL_HEADER]: successor,
                        Upgrade: "websocket",
                    },
                }),
                environment,
            ),
    };
}

function accept(response: Response): { readonly socket: WebSocket; readonly closed: Promise<CloseEvent> } {
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected the Computer socket");
    }
    const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve, { once: true }));
    socket.accept();
    return { socket, closed };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-08T00:00:00.000Z"));
});

afterEach(() => {
    vi.useRealTimers();
});

afterAll(async () => {
    await abortAllDurableObjects();
});

it("Given a copy of a connected daemon's credential, When the copy connects and the daemon reconnects with the credential it saved, Then the Relay revokes the Computer and tells both daemons their Computer was revoked", async () => {
    const runtime = await pairedComputer("copied-computer-credential");
    const saved = computerCredentialSuccessor(runtime.credential);
    const daemon = accept(await runtime.connect(runtime.credential, saved));

    // The copy was read from the daemon's disk, so it holds the credential the Relay accepts now.
    const copySuccessor = computerCredentialSuccessor(saved);
    const copy = accept(await runtime.connect(saved, copySuccessor));
    expect((await daemon.closed).reason).toBe("Daemon connection replaced");

    const reconnect = accept(await runtime.connect(saved, computerCredentialSuccessor(saved)));

    expect(await reconnect.closed).toMatchObject({ code: 1008, reason: "Computer revoked" });
    expect(await copy.closed).toMatchObject({ code: 1008, reason: "Computer revoked" });
    const copyAgain = accept(await runtime.connect(copySuccessor, computerCredentialSuccessor(copySuccessor)));
    expect(await copyAgain.closed).toMatchObject({ code: 1008, reason: "Computer revoked" });
});

it("Given a copy that rotated the credential twice, When the daemon reconnects with the credential it saved, Then the Relay still recognizes the copy and revokes the Computer", async () => {
    const runtime = await pairedComputer("twice-rotated-copy");
    const saved = computerCredentialSuccessor(runtime.credential);
    const daemon = accept(await runtime.connect(runtime.credential, saved));

    const first = computerCredentialSuccessor(saved);
    const second = computerCredentialSuccessor(first);
    accept(await runtime.connect(saved, first)).socket.close(1000, "Rotate again");
    const copy = accept(await runtime.connect(first, second));
    expect((await daemon.closed).reason).toBe("Daemon connection replaced");

    const reconnect = accept(await runtime.connect(saved, computerCredentialSuccessor(saved)));

    expect(await reconnect.closed).toMatchObject({ code: 1008, reason: "Computer revoked" });
    expect(await copy.closed).toMatchObject({ code: 1008, reason: "Computer revoked" });
});

it("Given a daemon whose connection reply was lost, When it repeats the same rotation, Then the Relay accepts it and the successor stays current", async () => {
    const runtime = await pairedComputer("repeated-computer-rotation");
    const successor = computerCredentialSuccessor(runtime.credential);
    accept(await runtime.connect(runtime.credential, successor)).socket.close(1000, "Reply lost");

    const repeated = accept(await runtime.connect(runtime.credential, successor));
    repeated.socket.close(1000, "Reconnect");

    accept(await runtime.connect(successor, computerCredentialSuccessor(successor))).socket.close(1000, "Done");
});
