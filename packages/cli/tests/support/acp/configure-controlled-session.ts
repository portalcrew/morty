import { methods } from "@agentclientprotocol/sdk/unstable";
import type { SessionConfigOption } from "@portalcrew/morty-client/protocol";
import { normalizeSessionConfigurationUpdate } from "../../../src/engine/acp/protocol/session-configuration.ts";

interface SessionConfigChange {
    readonly booleanValue: boolean;
    readonly configId: string;
    readonly signal: AbortSignal;
    readonly value: string;
}

interface SessionConfigTransport {
    readonly request: (
        method: string,
        params: Readonly<Record<string, unknown>>,
        failureMessage: string,
        signal: AbortSignal,
    ) => Promise<unknown>;
}

export class SessionConfigProtocolError extends Error {
    readonly code = "invalid_session_configuration_response";

    constructor(message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.name = "SessionConfigProtocolError";
    }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function updateCurrentValue(
    current: readonly SessionConfigOption[],
    configId: string,
    value: string,
): readonly SessionConfigOption[] {
    return current.map((option) => (option.id === configId ? { ...option, currentValue: value } : option));
}

export async function configureControlledSession(
    current: readonly SessionConfigOption[],
    change: SessionConfigChange,
    sessionId: string,
    transport: SessionConfigTransport,
): Promise<readonly SessionConfigOption[]> {
    const existing = current.find((option) => option.id === change.configId);
    if (existing === undefined) {
        return current;
    }
    if (existing.type === "select" && existing.category === "mode") {
        await transport.request(
            methods.agent.session.setMode,
            { modeId: change.value, sessionId: sessionId },
            "ACP agent exited while setting the session mode",
            change.signal,
        );
        return updateCurrentValue(current, existing.id, change.value);
    }
    const params: Readonly<Record<string, unknown>> =
        existing.type === "boolean"
            ? {
                  configId: existing.id,
                  sessionId: sessionId,
                  type: "boolean",
                  value: change.booleanValue,
              }
            : {
                  configId: existing.id,
                  sessionId: sessionId,
                  value: change.value,
              };
    const response = await transport.request(
        methods.agent.session.setConfigOption,
        params,
        "ACP agent exited while changing session configuration",
        change.signal,
    );
    if (!isRecord(response) || !Array.isArray(response["configOptions"])) {
        throw new SessionConfigProtocolError("The Agent returned an invalid session configuration response");
    }
    return normalizeSessionConfigurationUpdate(current, response["configOptions"]);
}
