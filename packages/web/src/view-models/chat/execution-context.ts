import type { ExecutionContext } from "../../components/chat/execution-context.ts";
import type { BotComputerConfiguration } from "../../services/chat/bot-chat-api.ts";
import { type BotChatHomeStore, homeCanStartConversation } from "./bot-chat-home-store.ts";
import type { ComputerStatusStore } from "./computer-status-store.ts";
import { connectionPresentation } from "./connection-presentation.ts";
import type { DraftControlsStore } from "./draft-controls-store.ts";
import type { SelectedMortySession } from "./open-session.ts";
import type { SessionConnection } from "./session-pane-store.ts";

export type { ExecutionContext };

export function pendingExecutionContext(
    home: BotChatHomeStore,
    computer: ComputerStatusStore,
    settings: DraftControlsStore["settings"],
): ExecutionContext {
    const loading = home.selection.kind === "loading" || home.initialization.kind === "loading";
    const base: ExecutionContext = {
        ...connectionPresentation(computer, home.selection, null),
        harness: "",
        computer: computer.computerConfiguration?.computer.computerName.trim() || (loading ? "Loading…" : "Unknown"),
        agent: loading ? "Loading…" : "Unknown",
        directory: null,
        directoryPlaceholder: loading ? "Loading…" : "Unknown",
    };
    if (home.selection.kind !== "draft" || !homeCanStartConversation(home, computer)) {
        return base;
    }
    switch (settings.kind) {
        case "ready":
        case "refreshing": {
            // The draft only chose which agent runs; its names come from the Computer configuration the page follows.
            const configured = computer.computerConfiguration?.computer;
            const offered = configured?.agents.find((agent) => agent.harness === settings.selectedAgent.harness);
            return {
                ...base,
                harness: settings.selectedAgent.harness,
                computer: configured?.computerName.trim() || "Unknown",
                agent: offered?.label.trim() || settings.selectedAgent.label.trim() || "Unknown",
                directory: settings.cwd.directoryLabel,
            };
        }
        case "loading":
        case "switching":
            return { ...base, agent: "Loading…", directoryPlaceholder: "Loading…" };
        case "failed":
        case "unreachable":
            return base;
    }
}

function sessionHarnessIdentity(
    session: SelectedMortySession,
    configuration: BotComputerConfiguration | null,
): { readonly harness: string; readonly agent: string } {
    const agent = configuration?.computer.agents.find((candidate) => candidate.harness === session.harness);
    return {
        harness: session.harness,
        agent: agent?.label.trim() || session.result.ready.agentName.trim() || "Unknown",
    };
}

export function activeHarnessMark(
    home: BotChatHomeStore,
    computer: ComputerStatusStore,
    settings: DraftControlsStore["settings"],
): { readonly harness: string; readonly label: string } {
    if (home.selection.kind === "ready") {
        const identity = sessionHarnessIdentity(home.selection.session, computer.computerConfiguration);
        return { harness: identity.harness, label: identity.agent };
    }
    const context = pendingExecutionContext(home, computer, settings);
    return { harness: context.harness, label: context.agent };
}

export function sessionExecutionContext(
    session: SelectedMortySession,
    home: BotChatHomeStore,
    computer: ComputerStatusStore,
    connection: SessionConnection,
): ExecutionContext {
    const configuration = computer.computerConfiguration;
    const identity = sessionHarnessIdentity(session, configuration);

    return {
        ...connectionPresentation(computer, home.selection, connection),
        harness: identity.harness,
        computer: configuration?.computer.computerName.trim() || "Unknown",
        agent: identity.agent,
        directory: session.result.ready.directoryLabel,
        directoryPlaceholder: "Unknown",
    };
}
