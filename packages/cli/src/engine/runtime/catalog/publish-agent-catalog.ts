import { MORTY_API_PREFIX } from "@morty-build/client/protocol";
import { fetch } from "undici";
import { environmentProxyDispatcher } from "../../util/network/environment-proxy.ts";
import type { RuntimeConfig } from "../config.ts";
import type { HeldComputerCredentials } from "../connection/computer-credentials.ts";
import { relayCredentialHeaders, relayHttpEndpoint } from "../relay/relay-authentication.ts";

const CATALOG_UPDATE_TIMEOUT_MILLISECONDS = 20_000;
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

class AgentCatalogPublishError extends Error {
    readonly code = "agent_catalog_update_failed";
    readonly diagnosticDetails: Readonly<Record<string, string>>;

    constructor(message: string, options: ErrorOptions = {}, diagnosticDetails: Readonly<Record<string, string>> = {}) {
        super(message, options);
        this.diagnosticDetails = diagnosticDetails;
        this.name = "AgentCatalogPublishError";
    }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeRelayErrorMessage(value: string): boolean {
    return (
        value.length > 0 &&
        value.length <= 512 &&
        Array.from(value).every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    );
}

async function rejectedCatalogError(response: FetchResponse): Promise<AgentCatalogPublishError> {
    let value: unknown;
    try {
        value = await response.json();
    } catch {
        return new AgentCatalogPublishError("The Relay rejected the Agent catalog update");
    }
    if (!isRecord(value) || !isRecord(value["error"])) {
        return new AgentCatalogPublishError("The Relay rejected the Agent catalog update");
    }
    const code = value["error"]["code"];
    const message = value["error"]["message"];
    if (
        typeof code !== "string" ||
        !/^[a-z][a-z0-9_]{0,63}$/.test(code) ||
        typeof message !== "string" ||
        !isSafeRelayErrorMessage(message)
    ) {
        return new AgentCatalogPublishError("The Relay rejected the Agent catalog update");
    }
    return new AgentCatalogPublishError(
        `The Relay rejected the Agent catalog update (${code}): ${message}`,
        {},
        {
            relayErrorCode: code,
        },
    );
}

function catalogEndpoint(config: RuntimeConfig): URL {
    const endpoint = relayHttpEndpoint(config.relayUrl);
    endpoint.pathname = `${MORTY_API_PREFIX}/v1/computers/${encodeURIComponent(config.computerId)}/catalog`;
    return endpoint;
}

export async function publishAgentCatalog(config: RuntimeConfig, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const timeoutSignal = AbortSignal.timeout(CATALOG_UPDATE_TIMEOUT_MILLISECONDS);
    const requestSignal = AbortSignal.any([signal, timeoutSignal]);
    const body = JSON.stringify({
        agents: config.catalog.read().map((agent) => ({
            agentPath: agent.agentIdentity.requestedPath,
            agentVersion: agent.agentVersion,
            capabilities: agent.capabilities,
            harness: agent.harness,
            label: agent.label,
        })),
    });
    const send = async (credentials: HeldComputerCredentials): Promise<FetchResponse> => {
        try {
            return await fetch(catalogEndpoint(config), {
                body,
                dispatcher: environmentProxyDispatcher,
                headers: { ...relayCredentialHeaders(credentials), "content-type": "application/json" },
                method: "PUT",
                signal: requestSignal,
            });
        } catch (error) {
            if (signal.aborted) {
                signal.throwIfAborted();
            }
            throw new AgentCatalogPublishError(
                timeoutSignal.aborted ? "The Agent catalog update timed out" : "The Agent catalog could not be updated",
                { cause: error },
            );
        }
    };
    const presented = await config.credentials.held(requestSignal);
    let response = await send(presented);
    if (response.status === 401) {
        // A connection can rotate the credential while this request is in flight. Presenting what the Computer holds
        // now, once, settles that; a refusal of current credentials stays a refusal.
        const held = await config.credentials.held(requestSignal);
        if (held.current !== presented.current || held.successor !== presented.successor) {
            await response.body?.cancel();
            response = await send(held);
        }
    }
    if (!response.ok) {
        throw await rejectedCatalogError(response);
    }
    await response.body?.cancel();
}
