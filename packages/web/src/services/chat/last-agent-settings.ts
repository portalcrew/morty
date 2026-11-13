import type { SessionConfigOption, SessionConfigurationSelection } from "@morty-build/client/protocol";
import {
    centralLocalStorage,
    lastAgentSettingsEntry,
    MAX_AGENT_SETTING_PREFERENCES,
} from "@/services/local-storage/central-local-storage";

/**
 * The Agent settings the user chose carry into a new draft. Only a choice is remembered: a value the Agent or the
 * draft's directory reports is read again for each draft, so a later change of that default is picked up.
 */
export function restoreLastAgentSettings(
    computerId: string,
    harness: string,
    options: readonly SessionConfigOption[],
): { readonly options: readonly SessionConfigOption[]; readonly restoredIds: ReadonlySet<string> } {
    const preferences = centralLocalStorage.read(lastAgentSettingsEntry(computerId, harness)) ?? [];
    const restoredIds = new Set<string>();
    const restored = options.map((option) => {
        const preference = preferences.find((candidate) => candidate.configId === option.id);
        if (option.type === "boolean" && preference?.type === "boolean") {
            restoredIds.add(option.id);
            return { ...option, booleanValue: preference.booleanValue };
        }
        if (
            option.type === "select" &&
            preference?.type === "select" &&
            option.values.some((value) => value.value === preference.value)
        ) {
            restoredIds.add(option.id);
            return { ...option, currentValue: preference.value };
        }
        return option;
    });
    return { options: restored, restoredIds };
}

/** Remembers one setting the user chose, keeping their other choices for this Agent. */
export function rememberAgentSettingChoice(
    computerId: string,
    harness: string,
    choice: SessionConfigurationSelection,
): void {
    const entry = lastAgentSettingsEntry(computerId, harness);
    const others = (centralLocalStorage.read(entry) ?? []).filter(
        (preference) => preference.configId !== choice.configId,
    );
    centralLocalStorage.write(entry, [...others, choice].slice(-MAX_AGENT_SETTING_PREFERENCES));
}
