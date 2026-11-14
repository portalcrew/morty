import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import * as v from "valibot";
import { memoryComputerCredentials } from "../packages/cli/tests/support/computer-credentials.ts";
import {
    type ComputerEncryptionAccess,
    MortyApiError,
    MortyClient,
    WsTransport,
} from "../packages/client/src/index.ts";
import type { NativeSessionTarget } from "../packages/client/src/protocol/index.ts";
import { connectControlledAgentRuntime, createMortyFakeDaemon } from "../tests/support/fake-daemon/runtime.ts";
import { mortyReply } from "../tests/support/fake-daemon/scenarios.ts";
import { createOwnerApi } from "../tests/support/owner-api.ts";

const targets = v.parse(
    v.object({ environments: v.object({ production: v.object({ morty_origin: v.string() }) }) }),
    JSON.parse(await readFile(new URL("./targets.json", import.meta.url), "utf8")),
);
const { values } = parseArgs({
    options: {
        origin: { type: "string", default: targets.environments.production.morty_origin },
        evidence: { type: "string", default: "session-access-evidence.json" },
    },
});
const origin = new URL(values.origin);
if (
    origin.origin !== values.origin ||
    (origin.origin !== targets.environments.production.morty_origin &&
        !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))
) {
    throw new Error("Verification may only target Morty production or an isolated local Worker");
}
const signingSecret = v.parse(
    v.optional(v.pipe(v.string(), v.minLength(32))),
    process.env["MORTY_SESSION_SIGNING_SECRET"] || undefined,
);
const signal = AbortSignal.timeout(120_000);
using sessionConnection = {
    transport: new WsTransport(),
    [Symbol.dispose]() {
        this.transport.close();
    },
};

async function requestSession(
    target: NativeSessionTarget,
    status: number,
    token: string,
    encryptionAccess: ComputerEncryptionAccess,
): Promise<void> {
    const client = new MortyClient({
        endpoint: origin.origin,
        computerId: encryptionAccess.computerId,
        transport: sessionConnection.transport,
        encryption: { access: encryptionAccess },
        credentialProvider: {
            credential: async (signal) => {
                signal.throwIfAborted();
                return token;
            },
        },
    });
    try {
        await client.sessions.readConfiguration(target, signal);
        if (status !== 200) {
            throw new Error(`Morty verification failed (Session configuration, expected ${status}, received 200)`);
        }
    } catch (cause) {
        signal.throwIfAborted();
        if (!(cause instanceof MortyApiError) || status === 200 || cause.status !== status) {
            throw cause;
        }
    } finally {
        client.close();
    }
}

async function request(path: string, status: number, token?: string, body?: object): Promise<unknown> {
    const response = await fetch(new URL(path, origin), {
        method: body === undefined ? "GET" : "POST",
        headers: {
            "content-type": "application/json",
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
        redirect: "error",
    });
    if (response.status !== status) {
        await response.body?.cancel();
        throw new Error(`Morty verification failed (${path}, HTTP ${response.status})`);
    }
    return await response.json();
}

const owner = v.parse(
    v.object({ computerToken: v.string(), computerId: v.string() }),
    await request("/morty/api/v1/computers", 201, undefined, {
        creationKey: randomBytes(32).toString("base64url"),
    }),
);
const pairing = v.parse(
    v.object({ pairingCode: v.string() }),
    await request(`/morty/api/v1/computers/${owner.computerId}/pairing`, 201, owner.computerToken, {
        idempotencyKey: `verification-${randomBytes(16).toString("hex")}`,
    }),
);
const behavior = { harness: "codex", agentName: "Controlled verification Agent", reply: mortyReply };
const harness = createMortyFakeDaemon(behavior);
const claim = v.parse(
    v.object({ computerCredential: v.string() }),
    await request(`/morty/api/v1/computers/${owner.computerId}/pairing/redeem`, 200, undefined, {
        pairingCode: pairing.pairingCode,
        computerName: "Deployment verification",
        workspaceName: "Isolated verification",
        agents: harness.catalog,
    }),
);
await using runtime = await connectControlledAgentRuntime({
    behavior,
    signal,
    connection: {
        computerId: owner.computerId,
        origin: origin.origin,
        credentials: memoryComputerCredentials(claim.computerCredential),
    },
});
const encryptionAccess = await runtime.encryptionAccess(signal);
using ownerApi = {
    ...createOwnerApi({
        origin: origin.origin,
        computerId: owner.computerId,
        credential: owner.computerToken,
        encryptionAccess,
    }),
    [Symbol.dispose]() {
        this.close();
    },
};
await ownerApi.api.verifyAgent("codex", signal);
const access = await ownerApi.api.createConversation(
    `verification-${randomBytes(16).toString("hex")}`,
    { harness: "codex", workspaceRef: ".", workspaceLabel: ".", configurations: [] },
    signal,
);
const credential = /^msession_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u.exec(access.credential);
const payload = credential?.[1];
const signature = credential?.[2];
if (payload === undefined || signature === undefined) {
    throw new Error("Invalid issued Session credential");
}
const signed = `msession_${payload}`;
if (signingSecret !== undefined) {
    const expected = createHmac("sha256", signingSecret).update(signed).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, "base64url"))) {
        throw new Error("The configured signing key was not used");
    }
}
await requestSession(access.target, 200, access.credential, encryptionAccess);
await requestSession(access.target, 401, `${signed}.${Buffer.alloc(32).toString("base64url")}`, encryptionAccess);
const successor = `morty_computer_v1_${randomBytes(32).toString("base64url")}`;
await request(`/morty/api/v1/computers/${owner.computerId}/identity/revoke-all-access`, 200, owner.computerToken, {
    successor,
});
await requestSession(access.target, 401, access.credential, encryptionAccess);
using successorApi = {
    ...createOwnerApi({
        origin: origin.origin,
        computerId: owner.computerId,
        credential: successor,
        encryptionAccess,
    }),
    [Symbol.dispose]() {
        this.close();
    },
};
const renewed = await successorApi.api.connectSession(access.target, signal);
await renewed.sessions.readConfiguration(access.target, signal);
await writeFile(
    values.evidence,
    `${JSON.stringify(
        {
            passed: true,
            architecture: "single-worker",
            revision: process.env["EXPECTED_REVISION"],
            configuredSigningKeyVerified: signingSecret !== undefined,
            signingKeyMode: signingSecret === undefined ? "preserved" : "supplied",
            runtimeVerificationStatus: 200,
            forgeryStatus: 401,
            endedHolderStatus: 401,
            successorHolderStatus: 200,
            agent: "controlled ACP harness; not vendor-Agent compatibility evidence",
        },
        null,
        2,
    )}\n`,
);
console.log(JSON.stringify({ passed: true, architecture: "single-worker" }));
