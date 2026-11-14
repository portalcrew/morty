import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { computerCredentialSuccessor, isIdentifier } from "@morty-build/client/protocol";
import { ensurePrivateDirectory } from "../../storage/files/local-files.ts";
import {
    type InstallationDirectory,
    installationDirectory,
    readInstallationFile,
    writeInstallationFile,
} from "../../storage/installation/installation-files.ts";
import { tryLock } from "../../storage/installation/local-lock.ts";
import { validateLocalPath } from "../../util/filesystem/private-path.ts";
import {
    type ComputerConnectionActivation,
    type ComputerConnectionInput,
    SavedComputerConnection,
} from "./computer-connection.ts";
import type { ComputerCredentials, HeldComputerCredentials } from "./computer-credentials.ts";
import { readRelayOrigin } from "./relay-origin.ts";

const PAIRING_GENERATION_PATTERN = /^mcn_[a-f0-9]{32}$/;
const COMPUTER_CREDENTIAL_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;
const CONNECTION_KEYS: readonly string[] = [
    "activation",
    "computerId",
    "pairingGeneration",
    "defaultWorkspace",
    "relayOrigin",
    "credentials",
];

export class RuntimeInstallationStoreError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "RuntimeInstallationStoreError";
    }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expectedKeys: readonly string[]): boolean {
    const keys = Object.keys(value);
    return keys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function validatePairingGeneration(value: string): string {
    if (!PAIRING_GENERATION_PATTERN.test(value)) {
        throw new RuntimeInstallationStoreError("invalid_connection_id", "The local pairing generation is invalid");
    }
    return value;
}

function validateIdentifier(value: string): string {
    if (!isIdentifier(value)) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    return value;
}

function validateComputerCredential(value: string): string {
    if (!COMPUTER_CREDENTIAL_PATTERN.test(value)) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    return value;
}

function parseRelayOrigin(value: string): URL {
    const origin = readRelayOrigin(value);
    if (origin.kind !== "valid") {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    return origin.url;
}

function pairingGeneration(): string {
    return `mcn_${randomUUID().replaceAll("-", "")}`;
}

function decodeSavedConnection(value: Readonly<Record<string, unknown>>): SavedComputerConnection {
    if (!hasExactKeys(value, CONNECTION_KEYS)) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    const activation = value["activation"];
    const pairingGeneration = value["pairingGeneration"];
    const defaultWorkspace = value["defaultWorkspace"];
    const computerId = value["computerId"];
    const relayOrigin = value["relayOrigin"];
    const credentials = value["credentials"];
    if (
        (activation !== "active" && activation !== "stopped") ||
        typeof computerId !== "string" ||
        typeof pairingGeneration !== "string" ||
        typeof defaultWorkspace !== "string" ||
        typeof relayOrigin !== "string" ||
        !isRecord(credentials) ||
        !hasExactKeys(credentials, ["current", "successor"]) ||
        typeof credentials["current"] !== "string" ||
        (credentials["successor"] !== null && typeof credentials["successor"] !== "string")
    ) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    return new SavedComputerConnection(
        activation,
        validatePairingGeneration(pairingGeneration),
        validateIdentifier(computerId),
        defaultWorkspace,
        parseRelayOrigin(relayOrigin),
        {
            current: validateComputerCredential(credentials["current"]),
            successor: credentials["successor"] === null ? null : validateComputerCredential(credentials["successor"]),
        },
    );
}

function decodeConnection(value: unknown): SavedComputerConnection {
    if (!isRecord(value)) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    return decodeSavedConnection(value);
}

async function readJsonFile(path: string, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const read = await readInstallationFile(path);
    switch (read.kind) {
        case "missing":
            throw new RuntimeInstallationStoreError(
                "connection_not_found",
                "The saved Runtime connection was not found",
                {
                    cause: read.cause,
                },
            );
        case "unopenable":
            throw new RuntimeInstallationStoreError(
                "connection_unavailable",
                "The saved Computer connection cannot be read",
                {
                    cause: read.cause,
                },
            );
        case "not-a-small-file":
            throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
        case "read":
            break;
    }
    signal.throwIfAborted();
    try {
        return JSON.parse(read.text);
    } catch (cause) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid", {
            cause,
        });
    }
}

async function writeJsonAtomically(
    path: string,
    value: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
): Promise<void> {
    try {
        await writeInstallationFile(path, `${JSON.stringify(value, null, 2)}\n`, signal);
    } catch (cause) {
        signal.throwIfAborted();
        throw new RuntimeInstallationStoreError("connection_unavailable", "The local Runtime state cannot be written", {
            cause,
        });
    }
}

export class RuntimeInstallationStore {
    readonly stateDirectory: InstallationDirectory;
    readonly pairingPath: string;

    private constructor(stateDirectory: InstallationDirectory) {
        this.stateDirectory = stateDirectory;
        this.pairingPath = join(stateDirectory, "pairing.json");
    }

    static readonly open = async (engineDataDir: string, signal: AbortSignal): Promise<RuntimeInstallationStore> => {
        signal.throwIfAborted();
        const dataDirectory = resolve(engineDataDir);
        try {
            await ensurePrivateDirectory(dataDirectory);
            await validateLocalPath(dataDirectory, true, true, signal);
        } catch (cause) {
            throw new RuntimeInstallationStoreError(
                "installation_unavailable",
                "The local installation cannot be initialized",
                {
                    cause,
                },
            );
        }
        signal.throwIfAborted();
        return new RuntimeInstallationStore(installationDirectory(dataDirectory));
    };

    private readonly changePairing = async <T>(operation: () => Promise<T>): Promise<T> => {
        const unlock = tryLock(join(this.stateDirectory, "pairing.lock.sqlite"));
        if (!unlock) {
            throw new RuntimeInstallationStoreError("pairing_busy", "Another operation is changing the pairing");
        }
        try {
            return await operation();
        } finally {
            unlock();
        }
    };

    readonly readConnection = async (
        pairingGeneration: string,
        signal: AbortSignal,
    ): Promise<SavedComputerConnection> => {
        validatePairingGeneration(pairingGeneration);
        const connection = decodeConnection(await readJsonFile(this.pairingPath, signal));
        if (connection.pairingGeneration !== pairingGeneration) {
            throw new RuntimeInstallationStoreError(
                "connection_not_found",
                "The requested pairing is no longer selected",
            );
        }
        return connection;
    };

    readonly saveConnection = async (
        input: ComputerConnectionInput,
        signal: AbortSignal,
    ): Promise<SavedComputerConnection> => {
        const stored = new SavedComputerConnection(
            "active",
            pairingGeneration(),
            validateIdentifier(input.computerId),
            input.defaultWorkspace,
            parseRelayOrigin(input.relayOrigin.toString()),
            { current: validateComputerCredential(input.computerCredential), successor: null },
        );
        await this.changePairing(async () => {
            await this.overwriteConnection(stored, signal);
        });
        return stored;
    };

    readonly currentConnection = async (signal: AbortSignal): Promise<SavedComputerConnection | null> => {
        try {
            return decodeConnection(await readJsonFile(this.pairingPath, signal));
        } catch (cause) {
            if (cause instanceof RuntimeInstallationStoreError && cause.code === "connection_not_found") {
                return null;
            }
            throw cause;
        }
    };

    readonly setConnectionActivation = async (
        pairingGeneration: string,
        activation: ComputerConnectionActivation,
        signal: AbortSignal,
    ): Promise<void> => {
        await this.changePairing(async () => {
            const connection = await this.readConnection(pairingGeneration, signal);
            await this.overwriteConnection(
                new SavedComputerConnection(
                    activation,
                    connection.pairingGeneration,
                    connection.computerId,
                    connection.defaultWorkspace,
                    connection.relayOrigin,
                    connection.credentials,
                ),
                signal,
            );
        });
    };

    /**
     * Pairing identity and its rotating credentials commit together. Every writer holds the same process-safe lock
     * and re-reads the selected pairing, so activation cannot restore old credentials and an old Computer cannot
     * overwrite a replacement. A rejected completion leaves the prepared successor durable for a safe retry.
     */
    readonly computerCredentials = (pairingGeneration: string): ComputerCredentials => ({
        prepare: async (signal) =>
            await this.changePairing(async () => {
                const connection = await this.readConnection(pairingGeneration, signal);
                const saved = connection.credentials;
                const rotation = {
                    current: saved.current,
                    successor: saved.successor ?? computerCredentialSuccessor(saved.current),
                };
                if (saved.successor === null) {
                    await this.overwriteCredentials(connection, rotation, signal);
                }
                return rotation;
            }),
        complete: async (rotation, signal) =>
            await this.changePairing(async () => {
                const connection = await this.readConnection(pairingGeneration, signal);
                const saved = connection.credentials;
                if (saved.current === rotation.successor) {
                    return;
                }
                if (saved.current !== rotation.current || saved.successor !== rotation.successor) {
                    throw new RuntimeInstallationStoreError(
                        "credential_conflict",
                        "The saved Computer credential changed during its rotation",
                    );
                }
                await this.overwriteCredentials(connection, { current: rotation.successor, successor: null }, signal);
            }),
        held: async (signal) => (await this.readConnection(pairingGeneration, signal)).credentials,
    });

    private readonly overwriteCredentials = async (
        connection: SavedComputerConnection,
        credentials: HeldComputerCredentials,
        signal: AbortSignal,
    ): Promise<void> => {
        await this.overwriteConnection(
            new SavedComputerConnection(
                connection.activation,
                connection.pairingGeneration,
                connection.computerId,
                connection.defaultWorkspace,
                connection.relayOrigin,
                credentials,
            ),
            signal,
        );
    };

    private readonly overwriteConnection = async (
        connection: SavedComputerConnection,
        signal: AbortSignal,
    ): Promise<void> => {
        await writeJsonAtomically(
            this.pairingPath,
            {
                activation: connection.activation,
                computerId: connection.computerId,
                pairingGeneration: connection.pairingGeneration,
                defaultWorkspace: connection.defaultWorkspace,
                relayOrigin: connection.relayOrigin.toString(),
                credentials: connection.credentials,
            },
            signal,
        );
    };
}
