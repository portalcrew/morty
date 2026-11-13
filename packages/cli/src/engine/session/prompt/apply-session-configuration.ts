import { randomUUID } from "node:crypto";
import type {
    NativeSessionTarget,
    SessionConfigOption,
    SessionConfigurationSelection,
} from "@morty-build/client/protocol";
import { AcpExecutionError } from "../../acp/acp-error.ts";
import type { AcpAgentDefinition } from "../../acp/agent/agent-definition.ts";
import type { Adapter } from "../../acp/native-history/preview-contract.ts";
import type { SessionManager } from "../manager/session-manager.ts";
import { inDependencyOrder } from "../settings/configuration-dependencies.ts";

function invalidSessionConfiguration(message: string): AcpExecutionError {
    return new AcpExecutionError(message, {}, "invalid_session_configuration");
}

function validateSessionConfigurationSelection(
    option: SessionConfigOption,
    selection: SessionConfigurationSelection,
): void {
    if (option.type !== selection.type) {
        throw invalidSessionConfiguration(`The Agent setting ${selection.configId} changed type`);
    }
    if (selection.type === "select" && !option.values.some((value) => value.value === selection.value)) {
        throw invalidSessionConfiguration(`The Agent setting ${selection.configId} has an unavailable value`);
    }
}

function sessionConfigurationSelectionIsAvailable(
    option: SessionConfigOption,
    selection: SessionConfigurationSelection,
): boolean {
    if (option.type !== selection.type) {
        return false;
    }
    return selection.type === "boolean" || option.values.some((value) => value.value === selection.value);
}

function sessionConfigurationMatches(option: SessionConfigOption, selection: SessionConfigurationSelection): boolean {
    validateSessionConfigurationSelection(option, selection);
    return selection.type === "boolean"
        ? option.booleanValue === selection.booleanValue
        : option.currentValue === selection.value;
}

/**
 * What a selection the Agent does not offer does. A Turn keeps the Agent's own value, since the member chose its
 * settings against an older snapshot; a Session being created refuses, since it must start with exactly what was asked.
 */
export type UnavailableSelection = "ignore" | "refuse";

function sessionConfigurationConflict(message: string): AcpExecutionError {
    return new AcpExecutionError(message, {}, "session_configuration_conflict");
}

function assertAppliedSessionConfiguration(
    options: readonly SessionConfigOption[],
    selections: readonly SessionConfigurationSelection[],
    unavailable: UnavailableSelection,
): void {
    for (const selection of selections) {
        const option = options.find((candidate) => candidate.id === selection.configId);
        const holds =
            option !== undefined && sessionConfigurationSelectionIsAvailable(option, selection)
                ? sessionConfigurationMatches(option, selection)
                : unavailable === "ignore";
        if (holds) {
            continue;
        }
        throw unavailable === "refuse"
            ? sessionConfigurationConflict(
                  `The Agent did not retain the selected setting "${selection.configId}". Review the settings and try again.`,
              )
            : invalidSessionConfiguration(`The Turn configuration does not match Agent setting ${selection.configId}`);
    }
}

function unavailableSessionConfigurationCategory(selection: SessionConfigurationSelection): string {
    if (selection.configId === "model") {
        return "model";
    }
    if (selection.configId === "reasoning_effort") {
        return "thought_level";
    }
    return "unknown";
}

/** Why the Agent cannot take a selection as stated, or null when it can. */
function unavailableReason(
    option: SessionConfigOption | undefined,
    selection: SessionConfigurationSelection,
): "setting_unavailable" | "setting_schema_mismatch" | "value_unavailable" | null {
    if (option === undefined) {
        return "setting_unavailable";
    }
    if (option.type !== selection.type) {
        return "setting_schema_mismatch";
    }
    if (selection.type === "select" && !option.values.some((value) => value.value === selection.value)) {
        return "value_unavailable";
    }
    return null;
}

async function applySessionConfigurationSelection(
    sessions: SessionManager,
    options: readonly SessionConfigOption[],
    selection: SessionConfigurationSelection,
    unavailable: UnavailableSelection,
    agent: AcpAgentDefinition,
    adapter: Adapter,
    cwd: string,
    commandId: string,
    sessionTarget: NativeSessionTarget,
    signal: AbortSignal,
): Promise<readonly SessionConfigOption[]> {
    const option = options.find((candidate) => candidate.id === selection.configId);
    const reason = unavailableReason(option, selection);
    if (reason !== null) {
        if (unavailable === "refuse") {
            throw sessionConfigurationConflict(
                `The selected Agent setting "${selection.configId}" is no longer available. Refresh the settings and try again.`,
            );
        }
        warnIgnoredSetting(
            "session_configuration_setting_ignored",
            commandId,
            sessionTarget,
            agent.harness,
            selection,
            option?.category ?? unavailableSessionConfigurationCategory(selection),
            reason,
        );
        return options;
    }
    if (option === undefined || sessionConfigurationMatches(option, selection)) {
        return options;
    }
    return (
        await sessions.applySessionConfiguration({
            adapter,
            ...selection,
            agent,
            cwd,
            requestId: `cfg_${randomUUID()}`,
            target: sessionTarget,
            signal,
        })
    ).configOptions;
}

/**
 * Applies a complete set of selections in dependency order, so a setting that decides another's choices comes first,
 * then checks that every applied selection still holds, since a later setting can change an earlier one.
 */
export async function applyCompleteSessionConfiguration(
    sessions: SessionManager,
    initialOptions: readonly SessionConfigOption[],
    selections: readonly SessionConfigurationSelection[],
    unavailable: UnavailableSelection,
    agent: AcpAgentDefinition,
    adapter: Adapter,
    cwd: string,
    commandId: string,
    sessionTarget: NativeSessionTarget,
    signal: AbortSignal,
): Promise<void> {
    let options = initialOptions;
    for (const selection of inDependencyOrder(selections, initialOptions)) {
        options = await applySessionConfigurationSelection(
            sessions,
            options,
            selection,
            unavailable,
            agent,
            adapter,
            cwd,
            commandId,
            sessionTarget,
            signal,
        );
    }
    assertAppliedSessionConfiguration(options, selections, unavailable);
}

function warnIgnoredSetting(
    event: string,
    commandId: string,
    sessionTarget: NativeSessionTarget,
    harness: string,
    selection: SessionConfigurationSelection,
    category: string,
    reason: string,
): void {
    const details: Readonly<Record<string, string>> = {
        harness,
        category,
        configId: selection.configId,
        reason,
        requestedValue: selection.type === "boolean" ? String(selection.booleanValue) : selection.value,
    };
    process.stderr.write(`Morty daemon warning ${JSON.stringify({ commandId, event, sessionTarget, ...details })}\n`);
}
