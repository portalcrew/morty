import type { SessionConfigOption, SessionConfigValue } from "@morty-build/client/protocol";
import { isRecord, readString } from "../../util/value-utils.ts";
export const MAXIMUM_CONFIG_OPTIONS = 100;

function truncate(value: string, maximum: number): string {
    return value.length <= maximum ? value : value.slice(0, maximum);
}

function readBoolean(value: unknown, fallback = false): boolean {
    return typeof value === "boolean" ? value : fallback;
}

function normalizeConfigValue(
    option: Readonly<Record<string, unknown>>,
    groupId = "",
    groupName = "",
): SessionConfigValue | undefined {
    // A value id must be a string. The empty string is a real id — an Agent
    // names the provider default that way — so only a non-string value, which
    // carries no id at all, is refused.
    const value = option["value"];
    if (typeof value !== "string") {
        return undefined;
    }
    return {
        description: truncate(readString(option["description"]), 500),
        groupId: truncate(groupId, 128),
        groupName: truncate(groupName, 255),
        name: truncate(readString(option["name"], value), 255),
        value: truncate(value, 500),
    };
}

function normalizeConfigValues(value: unknown): readonly SessionConfigValue[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const normalized: SessionConfigValue[] = [];
    for (const entry of value) {
        if (!isRecord(entry)) {
            continue;
        }
        const groupedOptions = entry["options"];
        if (Array.isArray(groupedOptions)) {
            const groupId = readString(entry["group"]);
            const groupName = readString(entry["name"]);
            for (const groupedOption of groupedOptions) {
                if (isRecord(groupedOption)) {
                    const normalizedValue = normalizeConfigValue(groupedOption, groupId, groupName);
                    if (normalizedValue !== undefined) {
                        normalized.push(normalizedValue);
                    }
                }
            }
            continue;
        }
        const normalizedEntry = normalizeConfigValue(entry);
        if (normalizedEntry !== undefined) {
            normalized.push(normalizedEntry);
        }
    }
    return normalized.slice(0, 500);
}

function duplicatesThinkingOption(
    options: readonly SessionConfigOption[],
    currentValue: string,
    values: readonly SessionConfigValue[],
): boolean {
    return options.some(
        (option) =>
            option.type === "select" &&
            option.category === "thought_level" &&
            option.currentValue === currentValue &&
            option.values.length === values.length &&
            values.every((value) => option.values.some((candidate) => candidate.value === value.value)),
    );
}

function normalizeConfigOptions(value: unknown, modes: unknown): readonly SessionConfigOption[] {
    const normalized: SessionConfigOption[] = [];
    if (Array.isArray(value)) {
        for (const option of value) {
            if (!isRecord(option)) {
                continue;
            }
            const id = truncate(readString(option["id"]), 128);
            const name = truncate(readString(option["name"], id), 255);
            const category = truncate(readString(option["category"]), 128);
            if (id.length === 0 || name.length === 0 || category === "_morty_permission") {
                continue;
            }
            if (option["type"] === "boolean") {
                normalized.push({
                    booleanValue: readBoolean(option["currentValue"]),
                    category,
                    description: truncate(readString(option["description"]), 500),
                    id,
                    name,
                    type: "boolean",
                });
                continue;
            }
            if (option["type"] === "select") {
                const values = normalizeConfigValues(option["options"]);
                const currentValue = truncate(readString(option["currentValue"]), 500);
                // The selected value must be one the Agent offers. It may be
                // empty, which is how an Agent reports the provider default.
                if (values.some((entry) => entry.value === currentValue)) {
                    normalized.push({
                        category,
                        currentValue,
                        description: truncate(readString(option["description"]), 500),
                        id,
                        name,
                        type: "select",
                        values,
                    });
                }
            }
        }
    }
    if (isRecord(modes)) {
        const values: SessionConfigValue[] = [];
        const availableModes = modes["availableModes"];
        if (Array.isArray(availableModes)) {
            for (const mode of availableModes) {
                if (!isRecord(mode)) {
                    continue;
                }
                const id = truncate(readString(mode["id"]), 500);
                if (id.length === 0) {
                    continue;
                }
                values.push({
                    description: truncate(readString(mode["description"]), 500),
                    groupId: "",
                    groupName: "",
                    name: truncate(readString(mode["name"], id), 255),
                    value: id,
                });
            }
        }
        const currentValue = truncate(readString(modes["currentModeId"]), 500);
        if (
            values.length > 1 &&
            currentValue.length > 0 &&
            values.some((entry) => entry.value === currentValue) &&
            !normalized.some((entry) => entry.category === "mode") &&
            !duplicatesThinkingOption(normalized, currentValue, values)
        ) {
            normalized.unshift({
                category: "mode",
                currentValue,
                description: "Agent session mode",
                id: "mode",
                name: "Mode",
                type: "select",
                values,
            });
        }
    }
    return normalized.slice(0, MAXIMUM_CONFIG_OPTIONS);
}

export function normalizeSessionConfiguration(response: unknown): readonly SessionConfigOption[] {
    const lifecycle = isRecord(response) ? response : {};
    return normalizeConfigOptions(lifecycle["configOptions"], lifecycle["modes"]);
}

export function normalizeSessionConfigurationUpdate(
    current: readonly SessionConfigOption[],
    value: unknown,
): readonly SessionConfigOption[] {
    const next = normalizeConfigOptions(value, undefined);
    const withMode = next.some((option) => option.category === "mode")
        ? next
        : [...current.filter((option) => option.category === "mode"), ...next].slice(0, MAXIMUM_CONFIG_OPTIONS);
    return withMode;
}
