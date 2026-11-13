import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { decodeIdentifier } from "@morty-build/client/protocol";
import jsQrImport from "jsqr";
import { PNG } from "pngjs";
import QRCode from "qrcode";
import { validateLocalPath } from "../engine/util/filesystem/private-path.ts";
import { readStateDirectory } from "../storage/state-directory.ts";
import { StateRootError, validateStateRoot } from "../storage/state-root.ts";
import {
    type CreatingIdentity,
    decodeSavedState,
    encodeSavedState,
    type IdentityState,
    type IssuedIdentity,
    type ReadyIdentity,
    type RetiringIdentity,
    type SavedState,
    serviceOrigin,
} from "./saved-state.ts";

/** A pairing the browser offered this computer. Its code is redeemed once and never appears on a command line. */
export interface SetupPairing {
    readonly relayOrigin: string;
    readonly computerId: string;
    readonly pairingCode: string;
    /** The Computer's default workspace. */
    readonly workspace: string;
}

/** Whether this computer's Morty offers one Agent, and how the user makes it available when it does not. */
export interface SetupAgentReport {
    readonly harness: string;
    readonly label: string;
    readonly status: string;
    readonly recoveryCommand: string;
    readonly minimumSupportedVersion: string;
}

/** The Morty installation in a state directory, as setup drives it. */
export interface SetupRuntime {
    /** The Computers the installation keeps a connection for. */
    /** The Computer this computer's saved pairing serves, if any. */
    readonly computer: (directory: string, signal: AbortSignal) => Promise<string | null>;
    /** Redeems a pairing, saves its connection, and has the daemon serve it. */
    readonly pair: (directory: string, pairing: SetupPairing, signal: AbortSignal) => Promise<void>;
    /** Has the daemon serve the saved connection, starting one when none runs. */
    readonly start: (directory: string, signal: AbortSignal) => Promise<void>;
    /** The Agents the installation finds on this computer. */
    readonly agents: (directory: string, signal: AbortSignal) => Promise<readonly SetupAgentReport[]>;
}

interface SetupEnvironment {
    /**
     * Where this computer keeps Morty's private state. Empty selects the operating system's local application data directory,
     * which is not synced to the user's other computers.
     */
    readonly state: string;
    readonly signal: AbortSignal;
    readonly emit: (value: Readonly<Record<string, unknown>>) => void;
    /** The calling Agent's environment, where its harness exposes the current session. Defaults to this process's. */
    readonly agentEnvironment?: Readonly<Record<string, string | undefined>>;
    readonly clock?: {
        readonly now: () => Date;
        readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
        /** A signal that aborts once the duration elapses. */
        readonly deadline?: (milliseconds: number) => AbortSignal;
    };
}

export type SetupHost = SetupEnvironment & { readonly runtime: SetupRuntime };

/** Where each supported harness exposes its current session to the commands its Agent runs. */
const harnessSessionVariables: ReadonlyMap<string, string> = new Map([
    ["claude", "CLAUDE_CODE_SESSION_ID"],
    ["codex", "CODEX_THREAD_ID"],
    ["pi", "PI_SESSION_ID"],
]);

function createdIdentity(issued: IssuedIdentity): ReadyIdentity {
    return {
        kind: "ready",
        ...issued,
        pairing: { kind: "none" },
        replacement: { kind: "unchanged" },
        rotation: { kind: "none" },
    };
}

function withoutPairingIntent(identity: ReadyIdentity): ReadyIdentity {
    return { ...identity, pairing: { kind: "none" } };
}

/** Saved before the replacement request: a lost reply cannot prove that access was not revoked. */
function withReplacementRequested(identity: ReadyIdentity): ReadyIdentity {
    return { ...identity, replacement: { kind: "unknown" } };
}

/** The successor identity, keeping the replaced one until it is ended. */
function replacedIdentity(previous: ReadyIdentity, successor: IssuedIdentity): ReadyIdentity {
    return {
        kind: "ready",
        ...successor,
        pairing: { kind: "none" },
        replacement: {
            kind: "revoked",
            previous: { kind: "pending", computerId: previous.computerId, token: previous.computerToken },
        },
        rotation: { kind: "none" },
    };
}

function withPreviousRetired(identity: ReadyIdentity, previous: RetiringIdentity): ReadyIdentity {
    return {
        ...identity,
        replacement: { kind: "revoked", previous: { kind: "retired", computerId: previous.computerId } },
    };
}

/** Saved before the request that makes `successor` the only local credential. */
function withRotationRequested(identity: ReadyIdentity, successor: string): ReadyIdentity {
    return { ...identity, rotation: { kind: "requested", successor } };
}

/** The local credential after the Worker replaced it with the requested successor. */
function rotatedIdentity(identity: ReadyIdentity, successor: string): ReadyIdentity {
    return { ...identity, computerToken: successor, rotation: { kind: "none" } };
}

/** Cleared only after a finished setup reported the replacement. */
function withReplacementReported(identity: ReadyIdentity): ReadyIdentity {
    return { ...identity, replacement: { kind: "unchanged" } };
}

interface StateLocation {
    readonly directory: string;
    readonly base: string;
}

/** A run whose saved identity can authenticate with the service. */
interface Context extends StateLocation {
    readonly identity: ReadyIdentity;
}

type ComputerSelection =
    | {
          readonly kind: "existing";
          readonly computerId: string;
          /** Whether the Relay records this Computer as the computer's paired Computer. */
          readonly paired: boolean;
      }
    | {
          readonly kind: "pairing";
          readonly pairingCode: string;
          readonly computerId: string;
          readonly relayUrl: string;
      };

interface VerifiedIdentity {
    readonly context: Context;
    /** Where the Computer's Runtime pairing stands, as the Relay records it. */
    readonly computerPairing: "unpaired" | "paired" | "revoked";
}

/**
 * What setup did to the Computer saved here. `replaced` ended every link and browser from the previous
 * one, so the agent must tell the user; the saved replacement keeps that owed until a finished
 * setup reports it, even when the run that replaced it stopped first.
 */
type ComputerOutcome = "created" | "reused" | "replaced";

interface SetupIdentity {
    readonly kind: "setup";
    readonly context: Context;
    readonly computer: Exclude<ComputerOutcome, "replaced">;
}

interface SetupOptions {
    readonly base: string;
    /** How long the browser that opens setup's link keeps access, or null for Morty's default; Morty validates it. */
    readonly deviceAccess: string | null;
    readonly cwd: string;
    readonly harness: string;
    readonly sessionId: string;
    /** Explicit local approval applies only to this Computer, never to a later replacement. */
    readonly replaceComputer: string | null;
}

type ReplacementAccess =
    | { readonly kind: "unchanged" }
    | { readonly kind: "unknown"; readonly previousComputerId: string }
    | { readonly kind: "revoked"; readonly previousComputerId: string; readonly computerId: string };

type ReplacementReason = "managed_computer_missing" | "replacement_result_unknown";

class ComputerReplacementRequiredError extends Error {
    readonly code = "COMPUTER_REPLACEMENT_REQUIRED";
    readonly computerId: string;
    readonly reason: ReplacementReason;

    constructor(computerId: string, reason: ReplacementReason) {
        super(
            reason === "managed_computer_missing"
                ? "The saved connection is missing. Replacing it will revoke earlier sharing links and browser access."
                : "An earlier replacement has an unknown result. Continue only with approval for that same Computer.",
        );
        this.name = "ComputerReplacementRequiredError";
        this.computerId = computerId;
        this.reason = reason;
    }

    readonly diagnostic = () => ({
        computerId: this.computerId,
        reason: this.reason,
        nextStep:
            "Explain the access impact and ask the user whether to continue, unless they already explicitly approved this same replacement. " +
            `Only after explicit approval, rerun the same setup command with --replace-computer ${this.computerId}. ` +
            "Do not remove local state or create another identity to bypass this confirmation.",
    });
}

/** The state directory belongs to another Morty service. Its identity is never sent elsewhere or replaced. */
class SavedIdentityOriginError extends Error {
    readonly code = "SAVED_IDENTITY_ORIGIN_MISMATCH";
    readonly savedBaseUrl: string;
    readonly requestedBaseUrl: string;

    constructor(savedBaseUrl: string, requestedBaseUrl: string) {
        super(`This state directory holds the Morty identity for ${savedBaseUrl}, not ${requestedBaseUrl}.`);
        this.name = "SavedIdentityOriginError";
        this.savedBaseUrl = savedBaseUrl;
        this.requestedBaseUrl = requestedBaseUrl;
    }

    readonly diagnostic = () => ({
        savedBaseUrl: this.savedBaseUrl,
        requestedBaseUrl: this.requestedBaseUrl,
        nextStep:
            `Setup changed nothing. To keep using the saved identity, rerun with --base-url ${this.savedBaseUrl}. ` +
            `To set up ${this.requestedBaseUrl} as well, rerun with MORTY_STATE_DIRECTORY set to a separate empty directory. ` +
            "Never remove or edit the saved state to bypass this: it holds the only credential for the saved identity.",
    });
}

interface RevokeAllAccessOptions {
    readonly base: string | undefined;
}

function errorCode(cause: unknown): unknown {
    return cause !== null && typeof cause === "object" && "code" in cause ? cause.code : undefined;
}

/** Starting or pairing the local Runtime failed; the cause says why. */
class RuntimeStartError extends Error {
    readonly code = "RUNTIME_START_FAILED";
    readonly nextStep =
        "Run morty start and rerun setup. Run morty logs when diagnosing startup; setup does not stop an existing daemon.";

    constructor(cause: unknown) {
        super("The local Runtime could not start serving this Computer.", { cause });
        this.name = "RuntimeStartError";
    }

    readonly diagnostic = () => ({ nextStep: this.nextStep });
}

/** Morty refused this shell's state root; setup must not continue against a state it cannot see. */
class MortyStateRootError extends Error {
    readonly code = "MORTY_STATE_ROOT_INVALID";
    readonly owningRoot: string;
    readonly nextStep =
        "This shell's MORTY_STATE_DIRECTORY names Morty installation data that an earlier Morty Runtime passed to this agent, not a state root. Rerun setup with MORTY_STATE_DIRECTORY set to the owning state root.";

    constructor(cause: StateRootError) {
        super("Morty refused this shell's state root.", { cause });
        this.name = "MortyStateRootError";
        this.owningRoot = cause.owningRoot;
    }

    readonly diagnostic = (access: ReplacementAccess) => ({
        owningRoot: this.owningRoot,
        nextStep: `${this.nextStep} ${
            access.kind === "unchanged"
                ? "Setup changed nothing; existing Morty links keep working."
                : "An earlier replacement may already have changed shared access. Report replacementAccess before retrying; do not assume the old links still work."
        }`,
    });
}

/** A failure the Morty service reported with its own error code. */
class RemoteError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RemoteError";
    }
}

/** What the agent should do after binding failed, chosen by the failure's code rather than its message. */
function bindingNextStep(code: string, harness: string): string {
    switch (code) {
        case "authentication_required":
            return `Ask the user to sign in to ${harness} on this computer; you cannot sign in for them. When they confirm, rerun setup; it reuses this Computer.`;
        case "TIMEOUT":
        case "RELAY_TIMEOUT":
        case "RELAY_UNAVAILABLE":
            return `Rerun setup without changing anything; it reuses this Computer. The Morty service or ${harness} may have been briefly unavailable. If it fails the same way again, confirm ${harness} answers a prompt in the working directory.`;
        default:
            return `Confirm ${harness} answers a prompt in the working directory and fix what stops it, then rerun setup; it reuses this Computer. If ${harness} answers and setup fails the same way again, report error.code to the user.`;
    }
}

/** Setup could not bind the Computer to the chosen harness. */
class AgentBindingError extends Error {
    readonly code: string;
    readonly harness: string;
    readonly nextStep: string;

    constructor(code: string, harness: string, cause: unknown) {
        super(`Setup could not connect ${harness} on this computer.`, { cause });
        this.name = "AgentBindingError";
        this.code = code;
        this.harness = harness;
        this.nextStep = bindingNextStep(code, harness);
    }

    readonly diagnostic = () => ({ harness: this.harness, nextStep: this.nextStep });
}

/** Why the local Agent inventory says the chosen harness cannot run, as `morty agents` reports it. */
interface HarnessDiagnosis {
    readonly status: string;
    readonly label: string;
    readonly recoveryCommand: string;
    readonly minimumSupportedVersion: string;
}

/** What the agent should do when the Computer does not offer the chosen harness, chosen by the inventory status. */
function harnessNextStep(harness: string, diagnosis: HarnessDiagnosis | null): string {
    const rerun = `rerun setup with --harness ${harness}; it reuses this Computer.`;
    switch (diagnosis?.status) {
        case "authentication_required":
            return `Ask the user to sign in to ${diagnosis.label} on this computer by running \`${diagnosis.recoveryCommand || harness}\` in a terminal; you cannot sign in for them. When they confirm, ${rerun}`;
        case "missing_agent":
            return `Morty cannot find ${diagnosis.label} on this computer. Make sure \`${harness}\` runs in a new terminal, then ${rerun} Do not switch to another harness.`;
        case "unsupported_version":
            return `Update ${diagnosis.label} to ${diagnosis.minimumSupportedVersion || "its latest release"} or newer, then ${rerun}`;
        case "ready":
            // Morty refreshes a running Computer's Agents when setup starts it.
            return `${diagnosis.label} is ready, but this computer's running Morty Computer has not picked it up yet. Rerun setup once. If it fails the same way again, ask the user before running \`morty stop\`, because it stops every Morty session on this computer; when they agree, run it and ${rerun}`;
        default:
            return `Confirm \`${harness}\` starts and answers a prompt in a new terminal and fix what stops it, then ${rerun} If it answers and setup fails the same way again, report error.code to the user.`;
    }
}

/** The Computer does not offer the chosen harness. */
class HarnessUnavailableError extends Error {
    readonly code = "HARNESS_UNAVAILABLE";
    readonly harness: string;
    readonly agentStatus: string;
    readonly nextStep: string;

    constructor(harness: string, diagnosis: HarnessDiagnosis | null) {
        super(`The Computer does not offer ${harness}.`);
        this.name = "HarnessUnavailableError";
        this.harness = harness;
        this.agentStatus = diagnosis?.status ?? "unknown";
        this.nextStep = harnessNextStep(harness, diagnosis);
    }

    readonly diagnostic = () => ({ harness: this.harness, status: this.agentStatus, nextStep: this.nextStep });
}

interface ErrorCause {
    readonly name: string;
    readonly message: string;
    readonly code?: string;
    readonly stack?: string;
    readonly cause?: ErrorCause;
    readonly errors?: readonly ErrorCause[];
}

function sanitizeErrorText(value: string) {
    return value
        .replace(
            /morty_(?:anon|computer)_v1_[A-Za-z0-9_-]+|morty_(?:transfer_v1|recovery_v1)\.[A-Za-z0-9._-]+/gu,
            "[REDACTED]",
        )
        .replace(/([?&](?:token|code)=)[^&\s#]+/giu, "$1[REDACTED]");
}

function serializeErrorCause(cause: unknown, seen = new WeakSet<object>()): ErrorCause {
    if (!(cause instanceof Error)) {
        return {
            name: "UnknownError",
            message: typeof cause === "string" ? sanitizeErrorText(cause) : "Unknown failure",
        };
    }
    if (seen.has(cause)) {
        return { name: cause.name, message: sanitizeErrorText(cause.message) };
    }
    seen.add(cause);
    const code = errorCode(cause);
    const nested = cause.cause === undefined ? undefined : serializeErrorCause(cause.cause, seen);
    const errors =
        cause instanceof AggregateError
            ? [...cause.errors].map((error) => serializeErrorCause(error, seen))
            : undefined;
    return {
        name: cause.name,
        message: sanitizeErrorText(cause.message),
        ...(typeof code === "string" ? { code } : {}),
        ...(cause.stack === undefined ? {} : { stack: sanitizeErrorText(cause.stack) }),
        ...(nested === undefined ? {} : { cause: nested }),
        ...(errors === undefined ? {} : { errors }),
    };
}

// A Computer comes online while it still republishes its harness catalog, so the catalog an existing Computer shows
// right after it starts may predate an install. A new pairing carries the catalog it was redeemed with instead.
const HARNESS_CATALOG_GRACE_MILLISECONDS = 30_000;

export async function runSetup(args: readonly string[], host: SetupHost): Promise<number> {
    const signal = AbortSignal.any([host.signal, AbortSignal.timeout(300000)]);
    const clock = host.clock ?? {
        now: () => new Date(),
        wait: async (milliseconds: number, parent: AbortSignal) => {
            await delay(milliseconds, undefined, { signal: parent });
        },
    };
    const deadline = host.clock?.deadline ?? ((milliseconds: number) => AbortSignal.timeout(milliseconds));
    const runId = crypto.randomUUID();
    const emit = (value: Readonly<Record<string, unknown>>) =>
        host.emit({ time: clock.now().toISOString(), runId, ...value });
    let replacementAccess: ReplacementAccess = { kind: "unchanged" };
    let setupReady = false;

    function progress(stage: string, message: string) {
        emit({ status: "progress", stage, message });
    }

    function fail(code: string, cause?: Error): never {
        throw Object.assign(new Error(code, cause === undefined ? undefined : { cause }), { code });
    }

    function object(value: unknown): Record<string, unknown> {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
            fail("INVALID_RESPONSE");
        }
        return Object.fromEntries(Object.entries(value));
    }

    function text(value: unknown, pattern = /^.+$/u): string {
        if (typeof value !== "string" || !pattern.test(value)) {
            fail("INVALID_RESPONSE");
        }
        return value;
    }

    const identifier = (value: unknown) => {
        try {
            return decodeIdentifier(value);
        } catch {
            return fail("INVALID_RESPONSE");
        }
    };
    const credential = (value: unknown) => text(value, /^morty_computer_v1_[A-Za-z0-9_-]{43}$/u);

    function origin(value: unknown) {
        return serviceOrigin(text(value)) ?? fail("INVALID_ORIGIN");
    }

    async function safeLocalPath(path: string, directory: boolean, privateAccess: boolean) {
        try {
            await validateLocalPath(path, directory, privateAccess, signal);
        } catch (cause) {
            if (signal.aborted) {
                signal.throwIfAborted();
            }
            if (errorCode(cause) === "ENOENT") {
                throw cause;
            }
            fail("UNSAFE_CONFIG_PATH", cause instanceof Error ? cause : undefined);
        }
    }

    /** Creates the state directory with private permissions, refusing one that is a link to somewhere else. */
    async function prepareStateDirectory(requested: string) {
        const directory = resolve(requested);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await safeLocalPath(directory, true, false);
        await safeLocalPath(directory, true, true);
        signal.throwIfAborted();
        return directory;
    }

    async function resolveWorkingDirectory(requested: string) {
        if (!isAbsolute(requested)) {
            fail("WORKING_DIRECTORY_REQUIRED");
        }
        try {
            const resolved = await realpath(requested);
            await validateLocalPath(resolved, true, false, signal);
            return resolved;
        } catch (cause) {
            if (signal.aborted) {
                signal.throwIfAborted();
            }
            if (errorCode(cause) === "UNSAFE_WORKING_DIRECTORY") {
                throw cause;
            }
            fail(errorCode(cause) === "ENOENT" ? "WORKING_DIRECTORY_UNAVAILABLE" : "UNSAFE_WORKING_DIRECTORY");
        }
    }

    async function writePrivateFile(path: string, value: string | Uint8Array) {
        const file = await open(
            path,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
        );
        try {
            await safeLocalPath(path, false, true);
            await file.writeFile(value);
            await file.sync();
        } finally {
            await file.close();
        }
    }

    /** The saved state, or null before this computer's first setup. */
    async function readSavedState(directory: string): Promise<SavedState | null> {
        const path = join(directory, "config.json");
        let content: string;
        try {
            await safeLocalPath(path, false, true);
            content = await readFile(path, "utf8");
        } catch (cause) {
            if (errorCode(cause) === "ENOENT") {
                return null;
            }
            throw cause;
        }
        let value: unknown;
        try {
            value = JSON.parse(content);
        } catch {
            fail("INVALID_CONFIGURATION");
        }
        const saved = decodeSavedState(value);
        return saved ?? fail("INVALID_CONFIGURATION");
    }

    /** The identity saved for the requested service. A state that belongs to another service is refused unchanged. */
    async function loadIdentity(directory: string, base: string): Promise<IdentityState> {
        const saved = await readSavedState(directory);
        if (saved === null) {
            return { kind: "none" };
        }
        if (saved.base !== base) {
            throw new SavedIdentityOriginError(saved.base, base);
        }
        return saved.identity;
    }

    /** Replaces the saved state atomically; every write follows an explicit identity transition. */
    async function writeSavedState(location: StateLocation, identity: CreatingIdentity | ReadyIdentity) {
        const temporary = join(location.directory, `.config-${crypto.randomUUID()}`);
        try {
            await writePrivateFile(
                temporary,
                JSON.stringify(encodeSavedState({ base: location.base, identity }), null, 2),
            );
            await rename(temporary, join(location.directory, "config.json"));
        } finally {
            await rm(temporary, { force: true });
        }
    }

    async function commit<Saved extends Context>(context: Saved, identity: ReadyIdentity): Promise<Saved> {
        await writeSavedState(context, identity);
        return { ...context, identity };
    }

    function restoreReplacementAccess(identity: IdentityState): void {
        if (identity.kind !== "ready") {
            replacementAccess = { kind: "unchanged" };
            return;
        }
        switch (identity.replacement.kind) {
            case "unchanged":
                replacementAccess = { kind: "unchanged" };
                return;
            case "unknown":
                replacementAccess = { kind: "unknown", previousComputerId: identity.computerId };
                return;
            case "revoked":
                replacementAccess = {
                    kind: "revoked",
                    previousComputerId: identity.replacement.previous.computerId,
                    computerId: identity.computerId,
                };
                return;
            default: {
                const exhaustive: never = identity.replacement;
                throw exhaustive;
            }
        }
    }

    function replacementFailure(access: ReplacementAccess) {
        if (access.kind === "unchanged") {
            return {};
        }
        return {
            replacementAccess: {
                ...access,
                setupReady,
                message:
                    access.kind === "unknown"
                        ? "The replacement result is unknown. Earlier access may already be revoked; do not assume the old links still work."
                        : setupReady
                          ? "Earlier access was revoked and the new connection is ready, but saving the completion notice failed."
                          : "Earlier sharing links and browser access were revoked, but the new setup has not finished.",
                nextStep:
                    "Report this access state to the user. Keep the saved local identity and retry setup to continue recovery; never clear local state to hide the failure.",
            },
        };
    }

    async function send(base: string, path: string, headers: Readonly<Record<string, string>>, body?: unknown) {
        const response = await fetch(new URL(`/morty/api/v1${path}`, base), {
            method: body === undefined ? "GET" : "POST",
            headers: { "content-type": "application/json", ...headers },
            redirect: "error",
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.any([signal, deadline(45000)]),
        });
        const value = object(await response.json());
        if (!response.ok) {
            remoteFailure(value, response.status);
        }
        return value;
    }

    /** Sends a request as the saved identity, to its Computer unless the route names one. */
    async function request(context: Context, route: string, body?: unknown) {
        const headers: Record<string, string> = { authorization: `Bearer ${context.identity.computerToken}` };
        if (route === "/replacement") {
            headers["x-morty-setup-run-id"] = runId;
        }
        const path = route.startsWith("/computers/") ? route : `/computers/${context.identity.computerId}${route}`;
        return await send(context.base, path, headers, body);
    }

    function remoteFailure(value: Readonly<Record<string, unknown>>, status: number): never {
        const failure = object(value["error"]);
        const code = text(failure["code"], /^[A-Za-z0-9_-]+$/u);
        const message =
            typeof failure["message"] === "string" ? failure["message"] : `Request failed with HTTP ${status}`;
        fail(code, new RemoteError(message));
    }

    /**
     * Ends the local identity of a Computer this computer replaced. Setup keeps it with the successor's identity until
     * then, so a run that stops on the way ends it next time instead of leaving a credential that opens the replaced
     * Computer. Nothing else from that Computer opens it: its replacement ended everything shared from it.
     */
    async function retireReplacedIdentity<Retiring extends Context>(context: Retiring): Promise<Retiring> {
        const replacement = context.identity.replacement;
        if (replacement.kind !== "revoked" || replacement.previous.kind !== "pending") {
            return context;
        }
        const previous = replacement.previous;
        const response = await fetch(
            new URL(`/morty/api/v1/computers/${previous.computerId}/identity/local-credential`, context.base),
            {
                method: "DELETE",
                headers: { authorization: `Bearer ${previous.token}` },
                redirect: "error",
                signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
            },
        );
        // A credential that no longer authenticates was ended by an earlier run that stopped before saving it.
        if (!response.ok && response.status !== 401) {
            remoteFailure(object(await response.json()), response.status);
        }
        return await commit(context, withPreviousRetired(context.identity, previous));
    }

    /**
     * Revokes every other credential, link and browser access, closes the chat windows open with them, and replaces
     * the local credential with a successor saved first. A run that lost the reply or failed repeats the same request
     * with whichever credential is still in force.
     */
    async function revokeAllAccessWithRotation<Revoking extends Context>(context: Revoking): Promise<Revoking> {
        const earlier = context.identity.rotation;
        const successor =
            earlier.kind === "requested"
                ? earlier.successor
                : `morty_computer_v1_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
        const requested = await commit(context, withRotationRequested(context.identity, successor));
        let revoked: Record<string, unknown>;
        try {
            revoked = await request(requested, "/identity/revoke-all-access", { successor });
        } catch (cause) {
            // The earlier request may have replaced the credential already; the successor then repeats it.
            if (earlier.kind !== "requested" || errorCode(cause) !== "UNAUTHENTICATED") {
                throw cause;
            }
            revoked = await request(
                { ...requested, identity: { ...requested.identity, computerToken: successor } },
                "/identity/revoke-all-access",
                { successor },
            );
        }
        if (revoked["status"] !== "access_revoked") {
            fail("INVALID_RESPONSE");
        }
        return await commit(requested, rotatedIdentity(requested.identity, successor));
    }

    /** Finishes revoking all access when an earlier run stopped before saving the replaced local credential. */
    async function settleCredentialRotation<Settling extends Context>(context: Settling): Promise<Settling> {
        if (context.identity.rotation.kind === "none") {
            return context;
        }
        progress("identity", "Finishing the earlier revocation of all access.");
        return await revokeAllAccessWithRotation(context);
    }

    function readSetupOptions(commandArgs: readonly string[]): SetupOptions {
        const { values } = parseArgs({
            args: [...commandArgs],
            options: {
                cwd: { type: "string" },
                harness: { type: "string" },
                "base-url": { type: "string" },
                "session-id": { type: "string" },
                "replace-computer": { type: "string" },
                "device-access": { type: "string" },
            },
        });
        if (values["base-url"] === undefined) {
            fail("BASE_URL_REQUIRED");
        }
        if (values.harness === undefined) {
            fail("HARNESS_REQUIRED");
        }
        if (values.cwd === undefined) {
            fail("WORKING_DIRECTORY_REQUIRED");
        }
        const harness = identifier(values.harness);
        return {
            base: origin(values["base-url"]),
            deviceAccess: values["device-access"] ?? null,
            replaceComputer: values["replace-computer"] === undefined ? null : identifier(values["replace-computer"]),
            cwd: text(values.cwd),
            harness,
            sessionId: currentSessionId(harness, values["session-id"]),
        };
    }

    /**
     * The harness names the Agent's current session in the Agent's own environment. That local value is authoritative
     * over an ID the Agent passes, which only serves harnesses or runs, such as a manual one, without it. Only the
     * declared harness's variable is read: nested Agents inherit their outer harness's variable.
     */
    function currentSessionId(harness: string, argument: string | undefined): string {
        const variable = harnessSessionVariables.get(harness) ?? null;
        const exposed = variable === null ? undefined : (host.agentEnvironment ?? process.env)[variable];
        if (variable !== null && exposed !== undefined && exposed !== "") {
            const sessionId = identifier(exposed);
            if (argument !== undefined && argument !== sessionId) {
                emit({
                    status: "session_id_mismatch",
                    harness,
                    variable,
                    message: `Continuing the session named by ${variable} instead of --session-id.`,
                });
            }
            return sessionId;
        }
        if (argument === undefined) {
            emit({
                status: "session_unavailable",
                harness,
                variable,
                message:
                    variable === null
                        ? "This harness does not expose its current session. Pass --session-id."
                        : `${variable} is not set. Run setup from the Agent's own session, or pass --session-id.`,
            });
            fail("SESSION_ID_REQUIRED");
        }
        return identifier(argument);
    }

    function readRevokeAllAccessOptions(commandArgs: readonly string[]): RevokeAllAccessOptions {
        const { values } = parseArgs({
            args: [...commandArgs],
            options: { "base-url": { type: "string" } },
        });
        return { base: values["base-url"] === undefined ? undefined : origin(values["base-url"]) };
    }

    async function prepareIdentity(location: StateLocation, saved: IdentityState): Promise<SetupIdentity> {
        if (saved.kind === "ready") {
            progress("identity", "Reusing the saved identity.");
            return { kind: "setup", context: { ...location, identity: saved }, computer: "reused" };
        }
        progress("identity", "Creating the standalone identity and Computer.");
        // Keep the creation secret across failures. Until a reply supplies the computerId, each attempt
        // creates a new computer; once the pair is saved, subsequent runs link that exact pair instead.
        let creating: CreatingIdentity;
        if (saved.kind === "creating") {
            creating = saved;
        } else {
            creating = {
                kind: "creating",
                creationKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
            };
            await writeSavedState(location, creating);
        }
        const created = await send(
            location.base,
            "/computers",
            {},
            {
                creationKey: creating.creationKey,
            },
        );
        const identity = createdIdentity({
            computerToken: credential(created["computerToken"]),
            computerId: identifier(created["computerId"]),
        });
        await writeSavedState(location, identity);
        return { kind: "setup", context: { ...location, identity }, computer: "created" };
    }

    async function verifyIdentityAndComputer(context: Context): Promise<VerifiedIdentity> {
        const session = await request(context, "/identity/link", { computerId: context.identity.computerId });
        if (identifier(session["computerId"]) !== context.identity.computerId) {
            fail("IDENTITY_CONFLICT");
        }
        // The Worker reads the Computer's pairing from the Relay, the same one every browser handoff opens.
        const computerPairing = text((await request(context, "/pairing-state"))["computerPairing"]);
        if (computerPairing !== "unpaired" && computerPairing !== "paired" && computerPairing !== "revoked") {
            fail("INVALID_RESPONSE");
        }
        return { context, computerPairing };
    }

    async function createComputerPairing(
        context: Context,
        requestKey: string,
    ): Promise<{ readonly computer: ComputerSelection; readonly expiresAt: number }> {
        const pairing = await request(context, "/pairing", { idempotencyKey: requestKey });
        const selection: ComputerSelection = {
            kind: "pairing",
            pairingCode: text(pairing["pairingCode"], /^[A-Za-z0-9-]+$/u),
            computerId: identifier(pairing["computerId"]),
            relayUrl: origin(pairing["relayUrl"]),
        };
        if (selection.computerId !== context.identity.computerId) {
            fail("COMPUTER_CONFLICT");
        }
        const expiresAt = Date.parse(text(pairing["expiresAt"], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u));
        if (!Number.isFinite(expiresAt)) {
            fail("INVALID_RESPONSE");
        }
        emit({ status: "prepared", computerId: context.identity.computerId });
        return { computer: selection, expiresAt };
    }

    async function replaceComputer(context: Context): Promise<Context> {
        const previousComputerId = context.identity.computerId;
        // Save before the request: a timeout or interrupted process cannot prove that access was not revoked.
        const prepared = await commit(context, withReplacementRequested(context.identity));
        replacementAccess = { kind: "unknown", previousComputerId };
        progress("replacement", "Replacing the saved connection with approval. Earlier shared access will be revoked.");
        const replacement = await request(prepared, "/replacement", {});
        const computerId = identifier(replacement["computerId"]);
        replacementAccess = { kind: "revoked", previousComputerId, computerId };
        // Report the access change immediately, even if saving or connecting the successor fails next.
        emit({
            status: "replacement_access_revoked",
            previousComputerId,
            computerId,
            message:
                "Earlier sharing links and browser access have been revoked. The new connection is still being set up.",
        });
        const saved = await commit(
            prepared,
            replacedIdentity(prepared.identity, {
                computerToken: credential(replacement["computerToken"]),
                computerId,
            }),
        );
        emit({ status: "computer_replaced", computerId: saved.identity.computerId });
        return await retireReplacedIdentity(saved);
    }

    async function prepareComputer(
        context: Context,
        computerPairing: VerifiedIdentity["computerPairing"],
        confirmedComputerId: string | null,
    ): Promise<{ readonly context: Context; readonly computer: ComputerSelection }> {
        progress("pairing", "Preparing the Computer connection.");
        const replaceWithApproval = async (reason: ReplacementReason) => {
            const computerId = context.identity.computerId;
            emit({
                status: "replacement_check",
                reason,
                computerId,
                expectedComputerId: computerPairing === "unpaired" ? null : computerId,
                approved: confirmedComputerId === computerId,
                platform: process.platform,
                nodeVersion: process.versions.node,
                runtimeStateSource: process.env["MORTY_STATE_DIRECTORY"]?.trim() ? "environment" : "default",
            });
            if (confirmedComputerId !== computerId) {
                throw new ComputerReplacementRequiredError(computerId, reason);
            }
            return await pairComputer(await replaceComputer(context));
        };
        // A restored local pairing cannot settle whether a previous request revoked shared access.
        // Finish that idempotent operation with its original approval before reporting setup ready.
        if (context.identity.replacement.kind === "unknown") {
            return await replaceWithApproval("replacement_result_unknown");
        }
        // Whether this computer's saved pairing already serves the Computer.
        const computerId = context.identity.computerId;
        const reused = async (): Promise<boolean> => {
            if ((await host.runtime.computer(context.directory, signal)) !== computerId) {
                return false;
            }
            emit({ status: "computer_reused", computerId });
            return true;
        };
        switch (computerPairing) {
            case "paired": {
                if (await reused()) {
                    return { context, computer: { kind: "existing", computerId, paired: true } };
                }
                // Losing the local pairing does not itself authorize ending shared access.
                return await replaceWithApproval("managed_computer_missing");
            }
            case "revoked":
                // Morty disconnected this computer because a copy of its connection key was used. The Computer and the
                // browsers that open it stay; only the computer's connection is paired again.
                emit({ status: "computer_revoked", computerId: context.identity.computerId });
                progress(
                    "pairing",
                    "Morty disconnected this computer because its connection key was used somewhere else. Pairing it again.",
                );
                // The connection list can retain the revoked credential. Only a new pairing can replace it.
                return await pairComputer(context);
            case "unpaired": {
                // A Computer an earlier run started for this computer may still be waiting for its pairing, so continue
                // on it while this computer still manages its connection.
                if (await reused()) {
                    return { context, computer: { kind: "existing", computerId, paired: false } };
                }
                return await pairComputer(context);
            }
        }
    }

    /**
     * Saves the operation identity before sending it. A lost reply resumes the same pairing; a confirmed expired
     * reservation permits one fresh request. Once answered, Computer connections supply the pairing fact and the saved intent is cleared.
     */
    async function pairComputer(
        context: Context,
    ): Promise<{ readonly context: Context; readonly computer: ComputerSelection }> {
        let requesting = context;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            signal.throwIfAborted();
            const requestKey =
                requesting.identity.pairing.kind === "requesting"
                    ? requesting.identity.pairing.requestKey
                    : crypto.randomUUID();
            requesting = await commit(requesting, {
                ...requesting.identity,
                pairing: { kind: "requesting", requestKey },
            });
            const { computer, expiresAt } = await createComputerPairing(requesting, requestKey);
            if (expiresAt <= clock.now().getTime()) {
                requesting = await commit(requesting, withoutPairingIntent(requesting.identity));
                continue;
            }
            return {
                context: await commit(requesting, withoutPairingIntent(requesting.identity)),
                computer,
            };
        }
        return fail("COMPUTER_PAIRING_UNAVAILABLE");
    }

    async function startRuntime(
        context: Context,
        computer: ComputerSelection,
        cwd: string,
        harness: string,
    ): Promise<void> {
        const reuseOnline = async () => {
            if (computer.kind !== "existing" || !(await computerIsOnline(context, computer, harness))) {
                return false;
            }
            emit({ status: "computer_already_online", computerId: computer.computerId, harness });
            return true;
        };
        // Starting a saved connection is idempotent. Redeeming a one-time pairing is not.
        const maximumAttempts = computer.kind === "existing" ? 3 : 1;
        for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
            signal.throwIfAborted();
            if (await reuseOnline()) {
                return;
            }
            try {
                if (computer.kind === "existing") {
                    await host.runtime.start(context.directory, signal);
                } else {
                    await host.runtime.pair(
                        context.directory,
                        {
                            relayOrigin: computer.relayUrl,
                            computerId: computer.computerId,
                            pairingCode: computer.pairingCode,
                            workspace: cwd,
                        },
                        signal,
                    );
                }
                emit({ status: "runtime_started" });
                return;
            } catch (startFailure) {
                signal.throwIfAborted();
                const cause = new RuntimeStartError(startFailure);
                // A launcher may fail after the daemon has connected successfully.
                if (await reuseOnline()) {
                    return;
                }
                if (attempt === maximumAttempts) {
                    throw cause;
                }
                emit({
                    status: "runtime_retrying",
                    attempt: attempt + 1,
                    maximumAttempts,
                    failure: cause.diagnostic(),
                });
                await clock.wait(1000, signal);
            }
        }
        fail("RUNTIME_START_FAILED");
    }

    function hasOnlineComputerAgent(computer: Record<string, unknown>, computerId: string, harness: string): boolean {
        return (
            computer["computerId"] === computerId &&
            computer["online"] === true &&
            Array.isArray(computer["agents"]) &&
            computer["agents"].some((agent) => object(agent)["harness"] === harness)
        );
    }

    /** The Agents the Computer offers while it is online, or null while it is not. */
    async function onlineComputerAgents(
        context: Context,
        computer: ComputerSelection,
    ): Promise<readonly string[] | null> {
        const botPath = `/computers/${context.identity.computerId}`;
        // A paired Computer is read through management; one still waiting for its pairing is among the setup candidates.
        const alreadyPaired = computer.kind === "existing" && computer.paired;
        const state = await request(context, `${botPath}/${alreadyPaired ? "workspace" : "setup/computers"}`, {});
        const candidates = alreadyPaired
            ? [object(state["computer"])]
            : Array.isArray(state["computers"])
              ? state["computers"].map(object)
              : [];
        const current = candidates.find(
            (candidate) => candidate["computerId"] === computer.computerId && candidate["online"] === true,
        );
        if (current === undefined || !Array.isArray(current["agents"])) {
            return null;
        }
        return current["agents"].map((agent) => identifier(object(agent)["harness"]));
    }

    async function computerIsOnline(context: Context, computer: ComputerSelection, harness: string): Promise<boolean> {
        return (await onlineComputerAgents(context, computer))?.includes(harness) === true;
    }

    /** One rule for every Computer setup waits on: an online Computer without the chosen harness cannot run it. */
    async function harnessUnavailable(context: Context, harness: string, available: readonly string[]): Promise<never> {
        emit({ status: "harness_unavailable", harness, available });
        throw new HarnessUnavailableError(harness, await diagnoseHarness(context, harness));
    }

    /**
     * Asks this computer's Morty why it does not offer the harness. The published catalog omits unusable Agents, but
     * the local inventory keeps their status and recovery command. Without an answer, setup still fails as unavailable.
     */
    async function diagnoseHarness(context: Context, harness: string): Promise<HarnessDiagnosis | null> {
        try {
            const reports = await host.runtime.agents(context.directory, AbortSignal.any([signal, deadline(60_000)]));
            const entry = reports.find((report) => report.harness === harness);
            if (entry === undefined) {
                return null;
            }
            const field = (value: string) => (value.length <= 200 && !/[\r\n]/u.test(value) ? value : "");
            return {
                status: field(entry.status) || "unknown",
                label: field(entry.label) || harness,
                recoveryCommand: field(entry.recoveryCommand),
                minimumSupportedVersion: field(entry.minimumSupportedVersion),
            };
        } catch (cause) {
            // Cancellation and the setup budget keep their own codes; any other failure leaves the harness unavailable
            // without a diagnosis.
            if (signal.aborted) {
                throw cause;
            }
            return null;
        }
    }

    async function waitForComputer(context: Context, computer: ComputerSelection, harness: string) {
        const computerId = computer.computerId;
        let attempts = 0;
        if (computer.kind === "pairing") {
            while (true) {
                signal.throwIfAborted();
                const status = await request(context, `/pairing`);
                if (status["status"] !== "pending" && status["status"] !== "paired") {
                    fail("COMPUTER_PAIRING_UNAVAILABLE");
                }
                if (attempts++ % 10 === 0) {
                    progress("computer", "Waiting for Computer pairing to complete.");
                }
                if (status["status"] === "paired") {
                    if (status["computerId"] !== computerId || !Array.isArray(status["agents"])) {
                        fail("INVALID_RESPONSE");
                    }
                    if (status["agents"].some((agent) => object(agent)["harness"] === harness)) {
                        emit({ status: "computer_paired", computerId, harness });
                        break;
                    }
                    await harnessUnavailable(
                        context,
                        harness,
                        status["agents"].map((agent) => identifier(object(agent)["harness"])),
                    );
                }
                await clock.wait(1000, signal);
            }
        }

        attempts = 0;
        // When the online Computer was first seen without the harness. Only a catalog that stayed without it through
        // the grace period means the harness is not installed.
        let missingSince: number | null = null;
        while (true) {
            signal.throwIfAborted();
            const agents = await onlineComputerAgents(context, computer);
            if (agents?.includes(harness) === true) {
                if (computer.kind === "existing") {
                    emit({ status: "computer_paired", computerId, harness });
                }
                emit({ status: "computer_online", computerId, harness });
                return;
            }
            if (agents === null) {
                missingSince = null;
            } else {
                const now = clock.now().getTime();
                missingSince ??= now;
                if (now - missingSince >= HARNESS_CATALOG_GRACE_MILLISECONDS) {
                    await harnessUnavailable(context, harness, agents);
                }
            }
            if (attempts++ % 10 === 0) {
                progress("computer", `Waiting for the Computer and ${harness} to come online.`);
            }
            await clock.wait(1000, signal);
        }
    }

    async function bindAgent(context: Context, harness: string) {
        progress("binding", `Connecting the Computer to ${harness} in the default working directory.`);
        try {
            await request(context, `/computers/${context.identity.computerId}/setup`, { harness });
        } catch (cause) {
            // Cancellation and the setup budget keep their own codes.
            if (signal.aborted || !(cause instanceof Error)) {
                throw cause;
            }
            if (cause.name === "TimeoutError") {
                throw new AgentBindingError("TIMEOUT", harness, cause);
            }
            const code = errorCode(cause);
            if (cause.cause instanceof RemoteError && typeof code === "string") {
                throw new AgentBindingError(code, harness, cause);
            }
            throw cause;
        }
        // The Relay records the Computer the computer paired, so the local pairing record is no longer needed.
        const saved = await commit(context, withoutPairingIntent(context.identity));
        emit({ status: "binding_activated", computerId: context.identity.computerId, harness });
        return saved;
    }

    /** Waits until the Computer is online and offers the harness this run set up. */
    async function waitForReadiness(context: Context, computer: ComputerSelection, requestedHarness: string) {
        const harness = identifier(requestedHarness);
        let attempts = 0;
        while (true) {
            signal.throwIfAborted();
            const configuration = await request(context, `/computers/${context.identity.computerId}/workspace`, {});
            if (hasOnlineComputerAgent(object(configuration["computer"]), computer.computerId, harness)) {
                return;
            }
            if (attempts++ % 10 === 0) {
                progress("activation", "Waiting for the Computer binding to become active.");
            }
            await clock.wait(1000, signal);
        }
    }

    async function createQrCode(value: string) {
        const image = await QRCode.toBuffer(value, {
            type: "png",
            errorCorrectionLevel: "M",
            margin: 4,
            width: 512,
        });
        const png = PNG.sync.read(image);
        const decoder: unknown = jsQrImport;
        if (typeof decoder !== "function") {
            fail("QR_DECODER_UNAVAILABLE");
        }
        const decoded: unknown = decoder(new Uint8ClampedArray(png.data), png.width, png.height);
        if (decoded === null || object(decoded)["data"] !== value) {
            fail("QR_VERIFICATION_FAILED");
        }

        const qrPath = join(tmpdir(), `morty-handoff-${crypto.randomUUID()}.png`);
        try {
            await writePrivateFile(qrPath, image);
            await safeLocalPath(qrPath, false, true);
        } catch (cause) {
            await rm(qrPath, { force: true });
            throw cause;
        }

        return qrPath;
    }

    async function finishSetup(
        context: Context,
        computer: ComputerSelection,
        options: SetupOptions,
        workingDirectory: string,
        identity: SetupIdentity["computer"],
    ) {
        await waitForReadiness(context, computer, options.harness);
        const transfer = await request(context, "/identity/transfers", {
            operationId: crypto.randomUUID(),
            ...(options.deviceAccess === null ? {} : { accessDuration: options.deviceAccess }),
        });
        const url = new URL(text(transfer["url"]));
        if (
            url.origin !== context.base ||
            url.pathname !== "/continue" ||
            url.search !== "" ||
            !new URLSearchParams(url.hash.slice(1)).has("code")
        ) {
            fail("INVALID_HANDOFF");
        }
        url.searchParams.set("harness", options.harness);
        url.searchParams.set("sessionId", options.sessionId);
        url.searchParams.set("workspace", workingDirectory);
        const handoffUrl = url.toString();
        // QR is an auxiliary representation: its capacity and decoding limits must
        // not prevent delivery of an otherwise valid handoff link.
        const qr = await (async (): Promise<
            | { readonly kind: "available"; readonly path: string }
            | { readonly kind: "unavailable"; readonly cause: ErrorCause }
        > => {
            try {
                return { kind: "available", path: await createQrCode(handoffUrl) };
            } catch (cause) {
                signal.throwIfAborted();
                return { kind: "unavailable", cause: serializeErrorCause(cause) };
            }
        })();
        signal.throwIfAborted();
        if (qr.kind === "unavailable") {
            emit({
                status: "qr_unavailable",
                error: { code: "QR_UNAVAILABLE", cause: qr.cause },
                message: "The QR image is unavailable. Use the handoff link instead.",
            });
        }
        const outcome: ComputerOutcome = context.identity.replacement.kind === "revoked" ? "replaced" : identity;
        emit({
            status: "ready",
            computerId: context.identity.computerId,
            url: handoffUrl,
            // The browser that opens the link keeps access until then, unless access is revoked earlier.
            accessExpiresAt: text(transfer["accessExpiresAt"]),
            workspace: workingDirectory,
            qrPath: qr.kind === "available" ? qr.path : null,
            computer: outcome,
            message:
                qr.kind === "available"
                    ? "Open the link or scan the QR code to chat. Keep the Computer online."
                    : "Open the link to chat. Keep the Computer online.",
        });
        setupReady = true;
        if (outcome === "replaced") {
            // Cleared only after ready reported it, so a run that stops earlier leaves the notice owed.
            await commit(context, withReplacementReported(context.identity));
        }
    }

    async function revokeAllAccess(options: RevokeAllAccessOptions) {
        const directory = await prepareStateDirectory(
            readStateDirectory({ ...process.env, MORTY_STATE_DIRECTORY: host.state }),
        );
        const saved = await readSavedState(directory);
        if (saved === null || saved.identity.kind !== "ready") {
            return fail("LOCAL_IDENTITY_REQUIRED");
        }
        // Never send the saved identity to a different origin, even when explicitly requested.
        if (options.base !== undefined && options.base !== saved.base) {
            throw new SavedIdentityOriginError(saved.base, options.base);
        }
        const revoked = await revokeAllAccessWithRotation(
            await retireReplacedIdentity({ directory, base: saved.base, identity: saved.identity }),
        );
        emit({
            status: "access_revoked",
            computerId: revoked.identity.computerId,
            message:
                "Previous sharing links and all other Morty credentials have been revoked, and chat windows opened with them have been closed. This computer's own credential was replaced, so copies of it no longer work.",
        });
    }

    async function preflightRuntime(directory: string) {
        progress("preflight", "Verifying the Morty CLI before creating an identity.");
        try {
            await validateStateRoot({ ...process.env, MORTY_STATE_DIRECTORY: directory });
        } catch (cause) {
            // The installation is fine; the shell names the wrong state root.
            if (cause instanceof StateRootError) {
                throw new MortyStateRootError(cause);
            }
            throw cause;
        }
        emit({ status: "runtime_verified", nodeVersion: process.versions.node, nodeExecutable: process.execPath });
    }

    async function setup(options: SetupOptions) {
        const cwd = await resolveWorkingDirectory(options.cwd);
        const directory = await prepareStateDirectory(
            readStateDirectory({ ...process.env, MORTY_STATE_DIRECTORY: host.state }),
        );
        const location: StateLocation = { directory, base: options.base };
        // Refuses a state that belongs to another service before anything runs, and explains a previous replacement
        // even when this run fails its local startup checks.
        restoreReplacementAccess(await loadIdentity(directory, options.base));
        await preflightRuntime(directory);
        const saved = await loadIdentity(directory, options.base);
        restoreReplacementAccess(saved);
        const identity = await prepareIdentity(location, saved);
        const verified = await verifyIdentityAndComputer(
            await retireReplacedIdentity(await settleCredentialRotation(identity.context)),
        );
        let computer = verified.context;
        emit({ status: "identity_ready", computerId: computer.identity.computerId });
        const prepared = await prepareComputer(computer, verified.computerPairing, options.replaceComputer);
        computer = prepared.context;
        await startRuntime(computer, prepared.computer, cwd, options.harness);
        await waitForComputer(computer, prepared.computer, options.harness);
        computer = await bindAgent(computer, options.harness);
        await finishSetup(computer, prepared.computer, options, cwd, identity.computer);
    }

    try {
        const action = args[0];
        const commandArgs = args.slice(1);
        switch (action) {
            case "setup":
                await setup(readSetupOptions(commandArgs));
                break;
            case "revoke-all-access":
                await revokeAllAccess(readRevokeAllAccessOptions(commandArgs));
                break;
            default:
                fail("INVALID_ARGUMENTS");
        }
        return 0;
    } catch (cause) {
        emit({
            error: {
                code: host.signal.aborted
                    ? "CANCELLED"
                    : signal.aborted
                      ? "SETUP_TIMEOUT"
                      : typeof errorCode(cause) === "string"
                        ? errorCode(cause)
                        : cause instanceof Error && cause.name === "TimeoutError"
                          ? "TIMEOUT"
                          : "SETUP_FAILED",
                cause: serializeErrorCause(cause),
                ...(cause instanceof MortyStateRootError
                    ? { runtime: cause.diagnostic(replacementAccess) }
                    : cause instanceof RuntimeStartError
                      ? { runtime: cause.diagnostic() }
                      : {}),
                ...(cause instanceof AgentBindingError ? { binding: cause.diagnostic() } : {}),
                ...(cause instanceof HarnessUnavailableError ? { harness: cause.diagnostic() } : {}),
                ...(cause instanceof ComputerReplacementRequiredError ? { replacement: cause.diagnostic() } : {}),
                ...(cause instanceof SavedIdentityOriginError ? { savedIdentity: cause.diagnostic() } : {}),
                ...replacementFailure(replacementAccess),
            },
        });
        return 1;
    }
}
