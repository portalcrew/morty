import type { SessionConfigOption } from "@portalcrew/morty-client/protocol";

export function isModelOption(option: Pick<SessionConfigOption, "category" | "id">): boolean {
    return option.id === "model" || option.category === "model";
}

function dependencyRank(configId: string, options: readonly SessionConfigOption[]): number {
    const category = options.find((option) => option.id === configId)?.category ?? "";
    if (isModelOption({ category, id: configId })) {
        return 0;
    }
    if (configId === "reasoning_effort" || category === "thought_level") {
        return 1;
    }
    return category === "model_config" ? 2 : 3;
}

/**
 * Orders settings so each is applied after the settings that decide its choices. Agents rebuild
 * effort levels, speed toggles and modes for the selected model, so the model comes first and the
 * settings scoped to it follow. The order in which a user edited the settings carries no meaning.
 */
export function inDependencyOrder<Selection extends { readonly configId: string }>(
    selections: readonly Selection[],
    options: readonly SessionConfigOption[],
): readonly Selection[] {
    return selections.toSorted(
        (left, right) =>
            dependencyRank(left.configId, options) - dependencyRank(right.configId, options) ||
            left.configId.localeCompare(right.configId),
    );
}
