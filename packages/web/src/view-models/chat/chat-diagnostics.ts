import {
    type ChatDiagnostics,
    diagnosticAgent,
    diagnosticVersion,
    modelDiagnosticProjection,
    modelSelections,
} from "../../services/diagnostics/model-catalog.ts";
import type { ChatWorkspace } from "./chat-workspace.ts";

/** Captured when the report is opened, before diagnostics requests can refresh the evidence. */
export function chatDiagnostics(workspace: ChatWorkspace): ChatDiagnostics {
    const home = workspace.home.getState();
    const project = modelDiagnosticProjection();
    const computer = workspace.computer.getState().computerConfiguration?.computer;
    if (home.selection.kind === "draft") {
        const settings = workspace.draftControls.getState().settings;
        if (settings.kind !== "ready") {
            return { kind: "unavailable", code: `draft_${settings.kind}` };
        }
        const catalog = settings.catalog;
        const visible = modelSelections(settings.options);
        return {
            kind: "available",
            view: "draft",
            computerId: computer?.computerId ?? null,
            computerOnline: computer?.online ?? false,
            agent: { harness: diagnosticAgent(catalog.harness), version: diagnosticVersion(catalog.agentVersion) },
            catalog: {
                source: "agent-settings",
                observedAt: catalog.observedAt,
                revision: catalog.revision,
                requestId: catalog.requestId,
                models: project(catalog.models),
                omittedGroups: Math.max(0, catalog.models.length - 8),
            },
            visibleModels: project(visible),
            visibleModelsObservedAt: catalog.observedAt,
            visibleModelsSource: "agent-settings",
            omittedVisibleGroups: Math.max(0, visible.length - 8),
        };
    }
    const pane = workspace.sessionPane();
    if (home.selection.kind !== "ready" || pane === null) {
        return { kind: "unavailable", code: `session_${home.selection.kind}` };
    }
    const { ready, requestId, target } = home.selection.session;
    const settings = pane.settings.getState();
    const original = modelSelections(ready.configOptions);
    const visible = modelSelections(settings.options);
    return {
        kind: "available",
        view: "session",
        computerId: computer?.computerId ?? null,
        computerOnline: computer?.online ?? false,
        agent: { harness: diagnosticAgent(target.harness), version: diagnosticVersion(ready.agentVersion) },
        catalog: {
            source: "session-ready",
            observedAt: settings.openedAt,
            revision: ready.configurationRevision,
            requestId,
            models: project(original),
            omittedGroups: Math.max(0, original.length - 8),
        },
        visibleModels: project(visible),
        visibleModelsObservedAt: settings.observedAt,
        visibleModelsSource: settings.source,
        omittedVisibleGroups: Math.max(0, visible.length - 8),
    };
}
