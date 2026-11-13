import { hostname } from "node:os";
import { basename, resolve } from "node:path";
import { isIdentifier, mortyApiUrl } from "@morty-build/client/protocol";
import { fetch, type Response } from "undici";
import type { CatalogAgent } from "../agent/catalog.ts";
import { discoverLocalAgentInventory, type LocalAgentInventory } from "../agent/discovery/discover-local-agents.ts";
import { RuntimeAgentDependencies } from "../runtime/config.ts";
import { ensureCanonicalDirectory } from "../storage/files/local-files.ts";
import { environmentProxyDispatcher } from "../util/network/environment-proxy.ts";
import { isRecord } from "../util/value-utils.ts";
import { discoverRuntimeAgentInventory } from "./catalog/discover-agent-catalog.ts";
import { publishAgentCatalog } from "./catalog/publish-agent-catalog.ts";
import { discoverConfiguredAgents } from "./catalog/refresh-agent-catalog.ts";
import { createCatalogAgentResolver } from "./catalog/resolve-catalog-agent.ts";
import { createRuntimeConfig, type RuntimeConfig, RuntimeLocalContext } from "./config.ts";
import type { SavedComputerConnection } from "./connection/computer-connection.ts";
import type { ComputerCredentials } from "./connection/computer-credentials.ts";
import { readRelayOrigin } from "./connection/relay-origin.ts";
import type { RuntimeInstallationStore } from "./connection/runtime-installation-store.ts";

const PAIRING_TIMEOUT_MILLISECONDS = 20_000;
const PAIRING_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){4}$/;
const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;

const REDEEM_RESPONSE_KEYS = ["computerId", "computerCredential"] as const;

interface PairCommandOptions {
    readonly code: string;
    readonly computerId: string;
    readonly relayOrigin: URL;
    readonly workspace: string;
}

interface ClaimPairingResponse {
    readonly computerId: string;
    readonly computerCredential: string;
}

export interface MortyComputerPairingOptions {
    readonly defaultWorkspace: string;
    readonly pairingCode: string;
    readonly computerId: string;
    readonly relayOrigin: string;
}

class PairingClientError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "PairingClientError";
    }
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expectedKeys: readonly string[]): boolean {
    const keys = Object.keys(value);
    return keys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function parseRelayOrigin(value: string): URL {
    const origin = readRelayOrigin(value);
    switch (origin.kind) {
        case "valid":
            return origin.url;
        case "malformed":
            throw new PairingClientError("invalid_relay_url", "The relay URL is invalid");
        case "unsupported-protocol":
            throw new PairingClientError("invalid_relay_url", "The relay URL must use http or https");
        case "credentials":
            throw new PairingClientError("invalid_relay_url", "The relay URL cannot contain credentials");
        case "insecure-remote":
            throw new PairingClientError("invalid_relay_url", "A remote relay must use https");
    }
}

function parsePairingCode(value: string): string {
    const code = value.trim().toUpperCase();
    if (!PAIRING_CODE_PATTERN.test(code)) {
        throw new PairingClientError(
            "invalid_pairing_code",
            "The pairing code must match the code shown in the browser",
        );
    }
    return code;
}

function validateComputerId(value: string): string {
    if (!isIdentifier(value)) {
        throw new PairingClientError("invalid_computer_id", "The Computer pairing ID is invalid");
    }
    return value;
}

async function resolveDefaultWorkspace(path: string): Promise<string> {
    const requestedWorkspace = resolve(path);
    let defaultWorkspace: string | null;
    try {
        defaultWorkspace = await ensureCanonicalDirectory(requestedWorkspace);
    } catch (error) {
        throw new PairingClientError("invalid_workspace", "The default workspace cannot be resolved", { cause: error });
    }
    if (defaultWorkspace === null) {
        throw new PairingClientError("invalid_workspace", "The default workspace is not a directory");
    }
    return defaultWorkspace;
}

async function readJsonResponse(response: Response): Promise<unknown> {
    const encoded = await response.text();
    try {
        return JSON.parse(encoded);
    } catch (error) {
        throw new PairingClientError("invalid_relay_response", "The relay returned an invalid response", {
            cause: error,
        });
    }
}

function readRelayError(value: unknown): PairingClientError {
    if (isRecord(value)) {
        const error = value["error"];
        if (isRecord(error)) {
            const code = error["code"];
            const message = error["message"];
            if (typeof code === "string" && typeof message === "string") {
                return new PairingClientError(code, message);
            }
        }
    }
    return new PairingClientError("pairing_failed", "The relay could not pair this computer");
}

function decodePairingResponse(value: unknown): ClaimPairingResponse {
    if (!isRecord(value) || !hasExactKeys(value, REDEEM_RESPONSE_KEYS)) {
        throw new PairingClientError("invalid_relay_response", "The relay returned an invalid pairing response");
    }
    const computerCredential = value["computerCredential"];
    const computerId = value["computerId"];
    if (
        typeof computerId !== "string" ||
        !isIdentifier(computerId) ||
        typeof computerCredential !== "string" ||
        !TOKEN_PATTERN.test(computerCredential)
    ) {
        throw new PairingClientError("invalid_relay_response", "The relay returned an invalid pairing response");
    }
    return { computerId, computerCredential };
}

async function claimPairing(
    options: PairCommandOptions,
    defaultWorkspace: string,
    localAgents: readonly CatalogAgent[],
    signal: AbortSignal,
): Promise<ClaimPairingResponse> {
    const agents = localAgents.map((agent) => ({
        agentPath: agent.agentIdentity.requestedPath,
        agentVersion: agent.agentVersion,
        capabilities: agent.capabilities,
        harness: agent.harness,
        label: agent.label,
    }));
    const endpoint = mortyApiUrl(
        options.relayOrigin,
        `/v1/computers/${encodeURIComponent(options.computerId)}/pairing/redeem`,
    );
    let response: Response;
    try {
        response = await fetch(endpoint, {
            body: JSON.stringify({
                agents,
                computerName: hostname(),
                pairingCode: options.code,
                workspaceName: basename(defaultWorkspace) || "Local workspace",
            }),
            dispatcher: environmentProxyDispatcher,
            headers: { "content-type": "application/json" },
            method: "POST",
            signal: AbortSignal.any([signal, AbortSignal.timeout(PAIRING_TIMEOUT_MILLISECONDS)]),
        });
    } catch (error) {
        signal.throwIfAborted();
        throw new PairingClientError("relay_unavailable", "The pairing relay could not be reached", { cause: error });
    }

    const value = await readJsonResponse(response);
    if (!response.ok) {
        throw readRelayError(value);
    }
    return decodePairingResponse(value);
}

function buildSavedRuntimeConfig(
    connection: SavedComputerConnection,
    credentials: ComputerCredentials,
    defaultWorkspace: string,
    inventory: LocalAgentInventory,
    localContext: RuntimeLocalContext,
): RuntimeConfig {
    const relayUrl = mortyApiUrl(connection.relayOrigin, "/v1/computers/connect");
    relayUrl.protocol = relayUrl.protocol === "https:" ? "wss:" : "ws:";

    const config: RuntimeConfig = createRuntimeConfig(
        {
            defaultWorkspace,
            computerId: connection.computerId,
            relayUrl,
            credentials,
        },
        new RuntimeAgentDependencies(inventory.readyAgents()),
        localContext,
        createCatalogAgentResolver(
            (refreshSignal) => discoverConfiguredAgents(config, refreshSignal),
            () => config,
            publishAgentCatalog,
        ),
    );
    return config;
}

async function pairComputer(
    installation: RuntimeInstallationStore,
    options: PairCommandOptions,
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv>,
): Promise<SavedComputerConnection> {
    const localContext = new RuntimeLocalContext(installation.stateDirectory, environment);
    const defaultWorkspace = await resolveDefaultWorkspace(options.workspace);
    const inventory = await discoverLocalAgentInventory({
        defaultWorkspace,
        dataDirectory: localContext.stateDirectory,
        environment: localContext.agentLaunchEnvironment,
        signal,
    });
    const claim = await claimPairing(options, defaultWorkspace, inventory.readyAgents(), signal);
    const connection = await installation.saveConnection(
        {
            computerId: claim.computerId,
            defaultWorkspace,
            relayOrigin: options.relayOrigin,
            computerCredential: claim.computerCredential,
        },
        signal,
    );
    return connection;
}

export async function pairComputerConnection(
    installation: RuntimeInstallationStore,
    options: MortyComputerPairingOptions,
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv>,
): Promise<SavedComputerConnection> {
    return await pairComputer(
        installation,
        {
            code: parsePairingCode(options.pairingCode),
            computerId: validateComputerId(options.computerId),
            relayOrigin: parseRelayOrigin(options.relayOrigin),
            workspace: options.defaultWorkspace,
        },
        signal,
        environment,
    );
}

export async function prepareComputerConnection(
    installation: RuntimeInstallationStore,
    connection: SavedComputerConnection,
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv>,
): Promise<RuntimeConfig> {
    const localContext = new RuntimeLocalContext(installation.stateDirectory, environment);
    const defaultWorkspace = await resolveDefaultWorkspace(connection.defaultWorkspace);
    const inventory = await discoverRuntimeAgentInventory(
        {
            defaultWorkspace,
            dataDirectory: localContext.stateDirectory,
            environment: localContext.agentLaunchEnvironment,
            signal,
        },
        connection.computerId,
    );
    return buildSavedRuntimeConfig(
        connection,
        installation.computerCredentials(connection.pairingGeneration),
        defaultWorkspace,
        inventory,
        localContext,
    );
}
