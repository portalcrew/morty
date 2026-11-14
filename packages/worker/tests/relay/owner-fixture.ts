import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { NativeSessionTarget, SessionAccessHolder } from "@morty-build/client/protocol";
import * as v from "valibot";
import { createTestOwner } from "../../../relay-test-support/src/identity-fixture.ts";
import { IdentityStorage } from "../../src/computer-relay/components/management/storage/identity-storage.ts";
import { SessionAccessSigner } from "../../src/computer-relay/components/runtime/entity/session-access-credential.ts";
import { SessionAccessService } from "../../src/computer-relay/components/runtime/service/session-access-service.ts";
import { DurableObjectDatabase } from "../../src/computer-relay/infra/durable-object-database.ts";
import { computerObjectName } from "../../src/contracts/computer-id.ts";
import worker from "../../src/worker/application.ts";
import { computerAccess } from "./registered-computer.ts";

export const ownerOrigin = "https://relay.test";
const ownerEnvironment = () => ({ ...env, APP_ORIGIN: ownerOrigin });
export const ownerRequest = (request: Request) => worker.fetch(request, ownerEnvironment());

const owners = new Map<string, string>();
export async function createOwner() {
    const owner = await createTestOwner(ownerRequest, ownerOrigin, AbortSignal.timeout(10_000));
    owners.set(owner.computerId, owner.token);
    return owner;
}

async function ownerHolder(computerId: string): Promise<SessionAccessHolder> {
    const token = owners.get(computerId);
    if (token === undefined) {
        throw new Error("Expected a publicly created owner");
    }
    return runInDurableObject(
        env.COMPUTER_RELAY.getByName(computerObjectName(computerId)),
        async (_instance, state) => {
            const credential = await new IdentityStorage(
                new DurableObjectDatabase(state.storage),
                computerId,
            ).findCredential(token, Date.now(), AbortSignal.timeout(10_000));
            if (credential === null) {
                throw new Error("Expected active owner access");
            }
            return { kind: "credential", credentialId: credential.credentialId };
        },
    );
}

/** Session protocol scenarios start with an authorized computer and an issued Session credential. */
export async function issueSession(computerId: string, target: NativeSessionTarget, expiresInSeconds = 900) {
    const holder = await ownerHolder(computerId);
    return runInDurableObject(env.COMPUTER_RELAY.getByName(computerObjectName(computerId)), async (_instance, state) =>
        new SessionAccessService(
            computerAccess(computerId, state.storage).access,
            new SessionAccessSigner(env.MORTY_SESSION_SIGNING_SECRET),
        ).issue({ computerId, target }, expiresInSeconds, holder, AbortSignal.timeout(10_000)),
    );
}

export const computerBackend = (computerId: string) => {
    const request = async (path: string, signal: AbortSignal) => {
        const token = owners.get(computerId);
        if (token === undefined) {
            throw new Error("Expected a publicly created owner");
        }
        const response = await ownerRequest(
            new Request(`${ownerOrigin}/morty/api/v1/computers/${computerId}/${path}`, {
                method: "POST",
                headers: { authorization: `Bearer ${token}` },
                signal,
            }),
        );
        if (!response.ok) {
            throw new Error(`Computer read failed: ${response.status}`);
        }
        return response.json();
    };
    return {
        computers: async (signal: AbortSignal) =>
            v.parse(
                v.object({
                    computers: v.array(
                        v.object({
                            computerId: v.string(),
                            computerName: v.string(),
                            online: v.boolean(),
                            agents: v.array(v.object({ harness: v.string(), label: v.string() })),
                        }),
                    ),
                }),
                await request("setup/computers", signal),
            ).computers,
        agents: async (signal: AbortSignal) =>
            v.parse(
                v.object({
                    computer: v.object({
                        computerId: v.string(),
                        computerName: v.string(),
                        online: v.boolean(),
                        agents: v.array(v.object({ harness: v.string(), label: v.string() })),
                    }),
                }),
                await request("workspace", signal),
            ).computer,
    };
};

/** Pairs through the public setup boundary and returns its current daemon credential. */
export async function pairComputer(computerId: string) {
    const token = owners.get(computerId);
    if (token === undefined) {
        throw new Error("Expected a publicly created owner");
    }
    const reservation = await ownerRequest(
        new Request(`${ownerOrigin}/morty/api/v1/computers/${computerId}/pairing`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
        }),
    );
    if (reservation.status !== 201) {
        throw new Error(`Pairing failed: ${reservation.status}`);
    }
    const { pairingCode } = v.parse(v.object({ pairingCode: v.string() }), await reservation.json());
    const redemption = await ownerRequest(
        new Request(`${ownerOrigin}/morty/api/v1/computers/${computerId}/pairing/redeem`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                pairingCode,
                computerName: "Test computer",
                workspaceName: "Test workspace",
                agents: [],
            }),
        }),
    );
    if (redemption.status !== 200) {
        throw new Error(`Redemption failed: ${redemption.status}`);
    }
    return v.parse(v.object({ computerCredential: v.string() }), await redemption.json()).computerCredential;
}
