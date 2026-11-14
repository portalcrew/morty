import { type ComputerEncryptionAccess, computerEncryptionAccessCodec } from "@morty-build/client";
import { createOwnerApi } from "../../../tests/support/owner-api.ts";
import { identityCalls } from "../../web/src/services/api/calls/identity.ts";
import { WorkerApiTransport } from "../../web/src/services/api/worker-api-transport.ts";

interface RequestOptions {
    readonly body?: unknown;
    readonly computer?: string;
    readonly token?: string;
    readonly signal: AbortSignal;
}

interface BrowserIdentity {
    readonly computerId: string;
    readonly token: string;
}

export function object(value: unknown, name: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`Expected ${name} to be an object`);
    }
    return Object.fromEntries(Object.entries(value));
}

export function text(value: unknown, name: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Expected ${name}`);
    }
    return value;
}

/** A fresh client-held key naming one anonymous user creation. */
export function anonymousCreationKey(): string {
    return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

export async function jsonRequest(origin: string, path: string, { body, computer, token, signal }: RequestOptions) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== undefined) {
        headers["authorization"] = `Bearer ${token}`;
    }
    const scopedPath =
        computer !== undefined && path.startsWith("/morty/api/v1/") && !path.startsWith("/morty/api/v1/computers/")
            ? path.replace("/morty/api/v1/", `/morty/api/v1/computers/${encodeURIComponent(computer)}/`)
            : path;
    const response = await fetch(new URL(scopedPath, origin), {
        method: body === undefined ? "GET" : "POST",
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    });
    const raw = await response.text();
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        throw new Error(`${path} returned invalid JSON (${response.status}): ${raw.slice(0, 500)}`);
    }
    if (!response.ok) {
        throw new Error(`${path} failed (${response.status}): ${raw.slice(0, 1_000)}`);
    }
    return object(value, path);
}

export class ChatApi {
    readonly origin: string;
    readonly signal: AbortSignal;
    identity: BrowserIdentity | undefined;

    constructor(origin: string, signal: AbortSignal) {
        this.origin = origin;
        this.signal = signal;
    }

    async useBrowserIdentity(value: unknown) {
        const identity = object(value, "anonymous identity");
        const computerId = text(identity["computerId"], "computerId");
        const token = text(identity["computerToken"], "Computer token");
        this.identity = {
            computerId,
            token,
        };
        return this.identity;
    }

    async createPairing() {
        return await this.#request("/morty/api/v1/pairing", {
            body: { idempotencyKey: crypto.randomUUID() },
        });
    }

    async readPairedAgent(harness: string) {
        const paired = await this.#request(`/morty/api/v1/pairing`);
        if (
            paired["status"] !== "paired" ||
            !Array.isArray(paired["agents"]) ||
            !paired["agents"].some((agent) => object(agent, "agent")["harness"] === harness)
        ) {
            throw new Error(`The paired Computer does not expose ${harness}`);
        }
    }

    async bindAgent(harness: string, encryptionAccess: ComputerEncryptionAccess) {
        const owner = this.#owner(encryptionAccess);
        try {
            await owner.api.verifyAgent(harness, AbortSignal.any([this.signal, AbortSignal.timeout(120_000)]));
        } finally {
            owner.close();
        }
    }

    /** Redeem through the production continuation page, keeping the Computer secret in the local fragment. */
    async browserHandoff(encryptionAccess: ComputerEncryptionAccess) {
        const identity = this.#requireIdentity();
        if (encryptionAccess.computerId !== identity.computerId) {
            throw new Error("Encrypted access belongs to a different Computer");
        }
        const transport = new WorkerApiTransport(this.origin, () => null);
        const request = identityCalls.createTransfer({
            origin: this.origin,
            computerId: identity.computerId,
            operationId: crypto.randomUUID(),
            accessDuration: null,
            replaces: null,
        });
        try {
            const response = await transport.fetch({
                ...request,
                headers: { authorization: `Bearer ${identity.token}`, "content-type": "application/json" },
                signal: AbortSignal.any([this.signal, AbortSignal.timeout(request.endpoint.timeoutMilliseconds)]),
            });
            const value: unknown = await response.json();
            if (!response.ok) {
                throw new Error(`Browser handoff failed (${response.status})`);
            }
            const url = new URL(text(object(value, "browser handoff")["url"], "handoff URL"));
            if (url.origin !== this.origin || url.pathname !== "/continue") {
                throw new Error("The browser handoff must target this Worker's continuation page");
            }
            const fragment = new URLSearchParams(url.hash.slice(1));
            fragment.set(
                "e2e",
                Buffer.from(computerEncryptionAccessCodec.encode(encryptionAccess), "utf8").toString("base64url"),
            );
            url.hash = fragment.toString();
            return url.href;
        } finally {
            transport.dispose();
        }
    }

    async readBinding(harness: string) {
        const owner = this.#owner();
        try {
            const { computer } = await owner.api.computerConfiguration(this.signal);
            if (computer.online !== true || !computer.agents.some((agent) => agent.harness === harness)) {
                throw new Error(`The configured Bot does not expose ${harness}`);
            }
        } finally {
            owner.close();
        }
    }

    #owner(encryptionAccess?: ComputerEncryptionAccess) {
        const identity = this.#requireIdentity();
        if (encryptionAccess !== undefined && encryptionAccess.computerId !== identity.computerId) {
            throw new Error("Encrypted access belongs to a different Computer");
        }
        return createOwnerApi({
            origin: this.origin,
            computerId: identity.computerId,
            credential: identity.token,
            ...(encryptionAccess === undefined ? {} : { encryptionAccess }),
        });
    }

    #requireIdentity() {
        if (this.identity === undefined) {
            throw new Error("The browser identity has not been created");
        }
        return this.identity;
    }

    async #request(path: string, options: { readonly body?: unknown } = {}) {
        const identity = this.#requireIdentity();
        return await jsonRequest(this.origin, path, {
            ...options,
            computer: identity.computerId,
            token: identity.token,
            signal: this.signal,
        });
    }
}
