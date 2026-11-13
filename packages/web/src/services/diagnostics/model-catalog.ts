import type { SessionConfigOption } from "@morty-build/client/protocol";

/** Evidence from the response that supplied the menu; never a new discovery made while reporting. */
export interface AgentModelCatalog {
    readonly harness: string;
    readonly agentVersion: string;
    readonly observedAt: string;
    readonly requestId: string;
    readonly revision: string;
    readonly models: readonly ModelSelection[];
}

export interface ModelSelection {
    readonly selected: string;
    readonly values: readonly string[];
}

export function modelSelections(options: readonly SessionConfigOption[]): readonly ModelSelection[] {
    return options.flatMap((option) =>
        option.category === "model" && option.type === "select"
            ? [{ selected: option.currentValue, values: option.values.map((value) => value.value) }]
            : [],
    );
}

// Only reviewed public identifiers leave the browser verbatim. Custom provider/deployment names
// can contain customer information; their report-local aliases still let support compare menus.
const publicModels = new Set([
    "gpt-6.1-sol",
    "gpt-6.1-terra",
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex",
    "gpt-5.3-codex-spark",
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.1",
    "gpt-5.1-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
    "gpt-5",
    "gpt-5-codex",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4o",
    "gpt-4o-mini",
    "o3",
    "o3-pro",
    "o4-mini",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-opus-4-5",
    "claude-haiku-4-5",
    "default",
    "auto",
]);

export interface ModelDiagnostic {
    readonly selected: string | null;
    readonly values: readonly string[];
    readonly count: number;
    readonly omitted: number;
    readonly privateCount: number;
}

export const diagnosticVersion = (value: string): string | null =>
    /(?:^|[\s(v])(\d{1,6}\.\d{1,6}\.\d{1,6}(?:-(?:alpha|beta|rc|dev|preview)(?:[.\d-]{0,24}))?(?:\+[a-f0-9]{1,16})?)(?=$|[\s)])/u.exec(
        value.slice(0, 128),
    )?.[1] ?? null;

export const diagnosticAgent = (value: string): string =>
    ["codex", "claude", "pi"].includes(value) ? value : "custom";

export function modelDiagnosticProjection() {
    const aliases = new Map<string, string>();
    const name = (value: string): string | null => {
        if (value === "") {
            return null;
        }
        if (publicModels.has(value)) {
            return value;
        }
        const previous = aliases.get(value);
        if (previous !== undefined) {
            return previous;
        }
        const alias = `private-model-${aliases.size + 1}`;
        aliases.set(value, alias);
        return alias;
    };
    return (models: readonly ModelSelection[]): readonly ModelDiagnostic[] =>
        models.slice(0, 8).map((model) => {
            const values = model.values.slice(0, 500).map((value) => name(value) ?? "empty-model-id");
            return {
                selected: name(model.selected),
                values,
                count: model.values.length,
                omitted: Math.max(0, model.values.length - values.length),
                privateCount: model.values.filter((value) => value !== "" && !publicModels.has(value)).length,
            };
        });
}

export type ChatDiagnostics =
    | { readonly kind: "unavailable"; readonly code: string }
    | {
          readonly kind: "available";
          readonly view: "draft" | "session";
          readonly computerId: string | null;
          readonly computerOnline: boolean;
          readonly agent: { readonly harness: string; readonly version: string | null };
          readonly catalog: {
              readonly source: "agent-settings" | "session-ready";
              readonly observedAt: string;
              readonly revision: string;
              readonly requestId: string;
              readonly models: readonly ModelDiagnostic[];
              readonly omittedGroups: number;
          };
          readonly visibleModels: readonly ModelDiagnostic[];
          readonly visibleModelsObservedAt: string;
          readonly visibleModelsSource: "agent-settings" | "session-ready" | "session-configuration";
          readonly omittedVisibleGroups: number;
      };
