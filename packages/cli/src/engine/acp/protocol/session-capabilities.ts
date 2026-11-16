import type { InitializeResponse } from "@agentclientprotocol/sdk/unstable";
import type { SessionCapabilities } from "@portalcrew/morty-client/protocol";
import { isRecord } from "../../util/value-utils.ts";

function hasTrueChildField(value: unknown, childKey: string, fieldKey: string): boolean {
    if (!isRecord(value)) {
        return false;
    }
    const child = Reflect.get(value, childKey);
    return isRecord(child) && Reflect.get(child, fieldKey) === true;
}

export function unsupportedSessionCapabilities(): SessionCapabilities {
    return Object.freeze({
        audioPrompt: false,
        closeSession: false,
        deleteSession: false,
        embeddedContextPrompt: false,
        imagePrompt: false,
        listSessions: false,
        loadSession: false,
        promptQueueing: false,
        renameSession: false,
        resumeSession: false,
        steering: false,
        unstableForkSession: false,
    });
}

export function normalizeAcpCapabilities(initialized: InitializeResponse): SessionCapabilities {
    const capabilities = initialized.agentCapabilities ?? {};
    const session = capabilities.sessionCapabilities;
    const prompt = capabilities.promptCapabilities;
    return Object.freeze({
        audioPrompt: prompt?.audio === true,
        closeSession: session?.close != null,
        deleteSession: session?.delete != null,
        embeddedContextPrompt: prompt?.embeddedContext === true,
        imagePrompt: prompt?.image === true,
        listSessions: session?.list != null,
        loadSession: capabilities.loadSession === true,
        promptQueueing: hasTrueChildField(capabilities._meta, "claudeCode", "promptQueueing"),
        renameSession: hasTrueChildField(initialized._meta, "renameSession", "supported"),
        resumeSession: session?.resume != null,
        steering: hasTrueChildField(initialized._meta, "steering", "supported"),
        unstableForkSession: session?.fork != null,
    });
}

/** Session opening can restrict an Agent-wide capability once the access mode is known. */
export function restrictAcpSessionCapabilities(
    capabilities: SessionCapabilities,
    response: unknown,
): SessionCapabilities {
    if (!isRecord(response) || !isRecord(response["_meta"])) {
        return capabilities;
    }
    const steering = response["_meta"]["steering"];
    if (!isRecord(steering) || steering["supported"] !== false) {
        return capabilities;
    }
    return Object.freeze({ ...capabilities, steering: false });
}
