import type { ComputerEncryptionAccess } from "@morty-build/client";
import {
    browserAccessEntry,
    type ComputerDestination,
    centralLocalStorage,
    computerEncryptionEntry,
    computerPreferenceEntry,
    MAX_REMEMBERED_COMPUTERS,
    type RememberedComputer,
    readableComputer,
    readableCredential,
} from "../local-storage/central-local-storage.ts";
import { encodeIdentityScope, type IdentityScope } from "./identity-scope-url.ts";

export type { ComputerDestination, RememberedComputer };

export const computerKey = (scope: IdentityScope): string => encodeIdentityScope(scope);

export function storedComputerEncryption(computerId: string): ComputerEncryptionAccess | null {
    const access = centralLocalStorage.read(computerEncryptionEntry(computerId));
    return access?.computerId === computerId ? access : null;
}

export function rememberComputerEncryption(access: ComputerEncryptionAccess): void {
    if (!centralLocalStorage.write(computerEncryptionEntry(access.computerId), access)) {
        throw new BrowserAccessStorageError("The browser could not save encrypted Computer access.");
    }
}

/**
 * The computers this browser can open, most recently used first. Each remembered Computer keeps its own access token.
 */
export function rememberedComputers(): readonly RememberedComputer[] {
    return openable(readStoredAccess()).toSorted((a, b) => b.lastUsedAt - a.lastUsedAt);
}

/** The token this browser holds for a Computer. */
export function storedToken(computerId: string): string | null {
    return readStoredAccess().credentials.get(computerId) ?? null;
}

/** The access this browser holds for a remembered Computer, or null when it holds none. */
export function storedTokenForComputer(computerId: string): string | null {
    const computer = rememberedComputers().find((entry) => entry.scope.computerId === computerId);
    return computer === undefined ? null : storedToken(computer.scope.computerId);
}

/** Keeps a newly issued access: its token, and its computer behind those already visited. */
function saveAccessWhileLocked(scope: IdentityScope, token: string): void {
    updateComputers(withComputer(rememberedComputers(), scope), { added: { computerId: scope.computerId, token } });
}

class BrowserAccessStorageError extends Error {
    readonly code = "browser_access_storage_unavailable";
}

export interface StoredAccessWriter {
    readonly save: (scope: IdentityScope, token: string) => void;
    readonly forget: (scope: IdentityScope) => void;
    readonly forgetRejected: (scope: IdentityScope, token: string) => boolean;
}

/**
 * Runs a change to the access this browser stores while no other tab of the browser changes it: opening a link reads
 * the access it replaces and saves the new one, and ending access reads the access it ends.
 */
export async function withStoredAccessLock<T>(
    signal: AbortSignal,
    change: (access: StoredAccessWriter) => Promise<T>,
): Promise<T> {
    const perform = () =>
        change({ save: saveAccessWhileLocked, forget: forgetComputer, forgetRejected: forgetComputerAccess });
    const locks: LockManager | null | undefined = typeof navigator === "undefined" ? undefined : navigator.locks;
    signal.throwIfAborted();
    return locks === null || locks === undefined
        ? await perform()
        : await locks.request("morty-stored-access", { signal }, perform);
}

/** The access that replaced `rejected` for this Computer, once another tab saved it, or null when none did. */
export async function replacedToken(computerId: string, rejected: string, signal: AbortSignal): Promise<string | null> {
    return await withStoredAccessLock(signal, async () => {
        const current = storedToken(computerId);
        return current !== null && current !== rejected ? current : null;
    });
}

/**
 * Forgets a computer whose access was found to be gone, unless another tab replaced that access meanwhile: then the
 * replacement is current and false says to check it instead.
 */
function forgetComputerAccess(scope: IdentityScope, token: string): boolean {
    if (storedToken(scope.computerId) !== token) {
        return false;
    }
    forgetComputer(scope);
    return true;
}

function forgetComputer(scope: IdentityScope): void {
    centralLocalStorage.remove(computerEncryptionEntry(scope.computerId));
    updateComputers(rememberedComputers().filter((computer) => computerKey(computer.scope) !== computerKey(scope)));
}

export function rememberComputerVisit(
    scope: IdentityScope,
    now: number,
    destination?: ComputerDestination,
    directory?: string,
): void {
    const saved = withComputer(rememberedComputers(), scope);
    const current = saved.find((computer) => computerKey(computer.scope) === computerKey(scope));
    if (current === undefined) {
        return;
    }
    centralLocalStorage.write(computerPreferenceEntry(scope), {
        ...current,
        destination: destination ?? current.destination,
        directory: directory?.slice(0, 4096) ?? current.directory,
        lastUsedAt: now,
    });
}

/** Background metadata changes cannot change access or which computer was last used. */
export function rememberComputerName(scope: IdentityScope, name: string): void {
    const current = rememberedComputers().find((computer) => computerKey(computer.scope) === computerKey(scope));
    if (current !== undefined) {
        centralLocalStorage.write(computerPreferenceEntry(scope), { ...current, name: name.trim().slice(0, 256) });
    }
}

export function computerAddress(scope: IdentityScope, destination: ComputerDestination): string {
    const query = new URLSearchParams({ identity: encodeIdentityScope(scope) });
    if (destination.kind === "session") {
        query.set("harness", destination.harness);
        query.set("sessionId", destination.sessionId);
    }
    return `/chat?${query}`;
}

/** Marks an address this browser built from what it remembers, rather than a link someone gave the user. */
const RESUME_PARAMETER = "resume";

/**
 * The address that continues on a computer where this browser left it. The remembered place is only a hint: if it is
 * gone, the computer opens at its chat home, as when the user returns through the plain address.
 */
export function resumeComputerAddress(scope: IdentityScope, destination: ComputerDestination): string {
    return `${computerAddress(scope, destination)}&${RESUME_PARAMETER}=1`;
}

/** Whether the address continues where this browser left a computer. */
export function resumesComputer(): boolean {
    return new URL(window.location.href).searchParams.has(RESUME_PARAMETER);
}

/**
 * Removes the resume marker once the computer opened. Until then it stays, so a retry after a failed attempt, or a
 * reload, still continues where this browser left the computer.
 */
export function settleResumedComputer(): void {
    const address = new URL(window.location.href);
    if (address.searchParams.has(RESUME_PARAMETER)) {
        address.searchParams.delete(RESUME_PARAMETER);
        window.history.replaceState(window.history.state, "", address);
    }
}

interface StoredAccess {
    readonly credentials: ReadonlyMap<string, string>;
    readonly computers: readonly RememberedComputer[];
}

function readStoredAccess(): StoredAccess {
    const snapshot = centralLocalStorage.read(browserAccessEntry);
    const credentials = new Map<string, string>();
    for (const [computerId, token] of Object.entries(snapshot?.credentials ?? {})) {
        const readable = readableCredential(computerId, token);
        if (readable !== null) {
            credentials.set(computerId, readable);
        }
    }
    const computers: RememberedComputer[] = [];
    for (const record of snapshot?.computers ?? []) {
        const readable = readableComputer(record);
        if (readable !== null) {
            computers.push({ ...readable, ...centralLocalStorage.read(computerPreferenceEntry(readable.scope)) });
        }
    }
    return { credentials, computers };
}

/** The computers this version can open: those whose token it can read. */
function openable(stored: StoredAccess): readonly RememberedComputer[] {
    return stored.computers.filter((computer) => stored.credentials.has(computer.scope.computerId));
}

/** The list with this computer in it. A new computer goes last, which makes room by dropping the least recent one. */
function withComputer(saved: readonly RememberedComputer[], scope: IdentityScope): readonly RememberedComputer[] {
    if (saved.some((computer) => computerKey(computer.scope) === computerKey(scope))) {
        return saved;
    }
    // A credential alone does not establish a successful visit. Keep it behind
    // previously visited computers until the application opens this access.
    return [
        ...saved.slice(0, MAX_REMEMBERED_COMPUTERS - 1),
        { scope, destination: { kind: "home" }, name: "", directory: null, lastUsedAt: 0 },
    ];
}

/**
 * The one place the saved computers change. A token leaves with the last computer that needed it, or when its access
 * is found to be gone, so a token is never dropped while its computer is listed, and never outlives its access.
 */
function updateComputers(
    computers: readonly RememberedComputer[],
    change: { readonly added?: { readonly computerId: string; readonly token: string } } = {},
): void {
    const { added } = change;
    const stored = readStoredAccess();
    const needed = new Set(computers.map((computer) => computer.scope.computerId));
    const kept = [...stored.credentials].filter(
        ([computerId]) => computerId !== added?.computerId && needed.has(computerId),
    );
    if (added !== undefined) {
        kept.push([added.computerId, added.token]);
    }
    const saved = centralLocalStorage.write(browserAccessEntry, {
        credentials: Object.fromEntries(kept),
        computers: computers.map(({ scope }) => ({ scope })),
    });
    if (!saved) {
        throw new BrowserAccessStorageError(
            "The browser could not save access. Allow browser storage and retry the link.",
        );
    }
}
