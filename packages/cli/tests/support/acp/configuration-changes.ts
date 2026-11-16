import type { SessionConfigOption } from "@portalcrew/morty-client/protocol";
import { MAXIMUM_CONFIG_OPTIONS } from "../../../src/engine/acp/protocol/session-configuration.ts";

type ModeSelection = { readonly kind: "unchanged" } | { readonly kind: "selected"; readonly modeId: string };

/** Bounded configuration deltas only; history and content never wait for a response. */
export type ConfigurationChanges =
    | { readonly kind: "unchanged" }
    | { readonly kind: "mode"; readonly modeId: string }
    | {
          readonly kind: "replacement";
          readonly options: readonly SessionConfigOption[];
          readonly modes: readonly SessionConfigOption[];
          readonly selection: ModeSelection;
      };

export function recordConfigurationOptions(
    changes: ConfigurationChanges,
    options: readonly SessionConfigOption[],
): ConfigurationChanges {
    const modes = options.filter((option) => option.category === "mode");
    const selection: ModeSelection =
        modes.length > 0
            ? { kind: "unchanged" }
            : changes.kind === "mode"
              ? { kind: "selected", modeId: changes.modeId }
              : changes.kind === "replacement"
                ? changes.selection
                : { kind: "unchanged" };
    return {
        kind: "replacement",
        options,
        modes: modes.length > 0 ? modes : changes.kind === "replacement" ? changes.modes : [],
        selection,
    };
}

export function recordConfigurationMode(changes: ConfigurationChanges, modeId: string): ConfigurationChanges {
    return changes.kind === "replacement"
        ? { ...changes, selection: { kind: "selected", modeId } }
        : { kind: "mode", modeId };
}

export function applyConfigurationMode(
    options: readonly SessionConfigOption[],
    modeId: string,
): readonly SessionConfigOption[] {
    return options.map((option) => (option.category === "mode" ? { ...option, currentValue: modeId } : option));
}

export function applyConfigurationChanges(
    base: readonly SessionConfigOption[],
    changes: ConfigurationChanges,
): readonly SessionConfigOption[] {
    switch (changes.kind) {
        case "unchanged":
            return base;
        case "mode":
            return applyConfigurationMode(base, changes.modeId);
        case "replacement": {
            const options = changes.options.some((option) => option.category === "mode")
                ? changes.options
                : [
                      ...(changes.modes.length > 0
                          ? changes.modes
                          : base.filter((option) => option.category === "mode")),
                      ...changes.options,
                  ].slice(0, MAXIMUM_CONFIG_OPTIONS);
            return changes.selection.kind === "selected"
                ? applyConfigurationMode(options, changes.selection.modeId)
                : options;
        }
    }
}
