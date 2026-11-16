import * as v from "valibot";

const computerIdSchema = v.pipe(v.string(), v.regex(/^prj_(wn|ap|an|as)_01_[A-Za-z0-9_-]{24}$/u));

export const identityScopeSchema = v.pipe(
    v.object({
        computerId: computerIdSchema,
    }),
    v.readonly(),
);

export type IdentityScope = v.InferOutput<typeof identityScopeSchema>;

export function encodeIdentityScope(scope: IdentityScope): string {
    const parsed = v.parse(identityScopeSchema, scope);
    return parsed.computerId;
}

/** Parses a query value back into a scope, or null when it cannot represent one. */
function decodeIdentityScope(value: string): IdentityScope | null {
    const parsed = v.safeParse(computerIdSchema, value);
    return parsed.success ? { computerId: parsed.output } : null;
}

export function hasIdentityScope(): boolean {
    return new URLSearchParams(window.location.search).has("identity");
}

export function readIdentityScope(): IdentityScope | null {
    const value = new URLSearchParams(window.location.search).get("identity");
    return value === null ? null : decodeIdentityScope(value);
}

function withIdentitySearch(modify: (parameters: URLSearchParams) => void): void {
    const url = new URL(window.location.href);
    modify(url.searchParams);
    window.history.replaceState(window.history.state, "", url);
}

/** Persists the scope into the current URL without adding a history entry. */
export function writeIdentityScope(scope: IdentityScope): void {
    withIdentitySearch((parameters) => {
        parameters.set("identity", encodeIdentityScope(scope));
    });
}

/** Leaves the address of a computer whose access ended for the plain chat address, without adding a history entry. */
export function leaveComputerAddress(): void {
    const destination = new URL(window.location.href);
    destination.pathname = "/chat";
    destination.searchParams.delete("identity");
    destination.searchParams.delete("sessionId");
    destination.searchParams.delete("harness");
    destination.hash = "";
    window.history.replaceState(window.history.state, "", destination);
}
