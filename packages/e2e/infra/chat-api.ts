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
        signal,
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

    async bindAgent(harness: string) {
        const identity = this.#requireIdentity();
        await this.#request(`/morty/api/v1/computers/${encodeURIComponent(identity.computerId)}/setup`, {
            body: { harness },
        });
    }

    async readBinding(harness: string) {
        const identity = this.#requireIdentity();
        const configuration = await this.#request(
            `/morty/api/v1/computers/${encodeURIComponent(identity.computerId)}/workspace`,
            { body: {} },
        );
        const computer = object(configuration["computer"], "computer");
        if (
            computer["online"] !== true ||
            !Array.isArray(computer["agents"]) ||
            !computer["agents"].some((agent) => object(agent, "agent")["harness"] === harness)
        ) {
            throw new Error(`The configured Bot does not expose ${harness}`);
        }
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
