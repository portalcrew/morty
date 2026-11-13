import { MortyApiError } from "@morty-build/client";
import type {
    NativeSessionTarget,
    SessionConfigOption,
    SessionConfigurationSelection,
} from "@morty-build/client/protocol";
import { createStore } from "zustand/vanilla";
import { rememberAgentSettingChoice } from "../../services/chat/last-agent-settings.ts";
import { recordBrowserError } from "../../services/diagnostics/browser-diagnostics.ts";
import { formatError, isSessionClosedFailure } from "../format-error.ts";
import type { SessionOperationConnection } from "./session-operation-connection.ts";

// Computer snapshots own current settings. Live updates and history reloads request a new
// snapshot; historical configuration events never become current settings. The revision
// travels with its snapshot and is sent only for explicit edits.

type ConfigurationSnapshot = {
    readonly configOptions: readonly SessionConfigOption[];
    readonly configurationRevision: string;
};

/** A change the user asked of the Session's settings. A failed change keeps its failure until the next one. */
type SettingsChange =
    | { readonly kind: "idle" }
    | { readonly kind: "configuring"; readonly configId: string }
    | { readonly kind: "failed"; readonly message: string };

export interface SessionSettingsStore {
    readonly openedAt: string;
    readonly observedAt: string;
    readonly source: "session-ready" | "session-configuration";
    readonly configurationRevision: string;
    readonly options: readonly SessionConfigOption[];
    readonly change: SettingsChange;
    /** Shows the settings a pane opening the Session read with it. */
    readonly opened: (snapshot: ConfigurationSnapshot) => void;
    /** Shows settings the Computer reported. */
    readonly adopt: (snapshot: ConfigurationSnapshot) => void;
    /**
     * Refines the shown settings from an authoritative read, made whenever the
     * history is loaded again. The conversation stays usable while the
     * read runs, a Computer that cannot answer keeps the current settings, and settings adopted after the
     * read started win. A newer read replaces an unfinished one.
     */
    readonly readInBackground: (
        read: (signal: AbortSignal) => Promise<ConfigurationSnapshot>,
        parentSignal: AbortSignal,
    ) => void;
    /**
     * Changes one setting through whichever pane follows the Session. The change is the Session's: switching panes
     * neither ends it nor drops its result.
     */
    readonly configure: (selection: SessionConfigurationSelection, signal: AbortSignal) => Promise<void>;
}

/** The Session's settings on this page and the change the user asked of them, whichever pane shows them. */
export function createSessionSettingsStore(options: {
    readonly computerId: string;
    readonly sessionTarget: NativeSessionTarget;
    readonly connection: SessionOperationConnection;
}) {
    return createStore<SessionSettingsStore>()((set, get) => {
        let pendingRead: AbortController | null = null;
        const openedAt = new Date().toISOString();
        // A mutation response acknowledges the edit; it may already be older than another client's edit.
        // All refreshes use the same read lifetime so newer observations invalidate older reads.
        const refresh = (signal: AbortSignal): void =>
            get().readInBackground(
                (readSignal) =>
                    options.connection.send(
                        (client, requestSignal) =>
                            client.sessions.readConfiguration(options.sessionTarget, requestSignal),
                        readSignal,
                    ),
                signal,
            );
        return {
            openedAt,
            observedAt: openedAt,
            source: "session-ready",
            options: [],
            configurationRevision: "",
            change: { kind: "idle" },
            opened: ({ configOptions, configurationRevision }) => {
                pendingRead?.abort(new DOMException("The Session was opened again", "AbortError"));
                pendingRead = null;
                const now = new Date().toISOString();
                set({
                    openedAt: now,
                    observedAt: now,
                    source: "session-ready",
                    options: configOptions,
                    configurationRevision,
                });
            },
            adopt: ({ configOptions, configurationRevision }) => {
                pendingRead?.abort(new DOMException("Newer settings were adopted", "AbortError"));
                pendingRead = null;
                set({
                    options: configOptions,
                    configurationRevision,
                    observedAt: new Date().toISOString(),
                    source: "session-configuration",
                });
            },
            readInBackground: (read, parentSignal) => {
                pendingRead?.abort(new DOMException("A newer settings read replaced this one", "AbortError"));
                const controller = new AbortController();
                pendingRead = controller;
                const signal = AbortSignal.any([parentSignal, controller.signal, AbortSignal.timeout(45_000)]);
                void read(signal)
                    .then(
                        (result) => {
                            if (!parentSignal.aborted && !controller.signal.aborted) {
                                get().adopt(result);
                            }
                        },
                        (cause: unknown) => {
                            if (!parentSignal.aborted && !controller.signal.aborted) {
                                recordBrowserError("read-session-settings", cause);
                            }
                        },
                    )
                    .finally(() => {
                        if (pendingRead === controller) {
                            pendingRead = null;
                        }
                    });
            },
            configure: async (selection, signal) => {
                set({ change: { configId: selection.configId, kind: "configuring" } });
                try {
                    await options.connection.send(
                        async (client, requestSignal) => {
                            return await client.sessions.updateConfiguration(
                                options.sessionTarget,
                                { ...selection, expectedConfigurationRevision: get().configurationRevision },
                                requestSignal,
                            );
                        },
                        AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
                    );
                    signal.throwIfAborted();
                    rememberAgentSettingChoice(
                        options.computerId,
                        options.sessionTarget.harness,
                        selection.type === "boolean"
                            ? { configId: selection.configId, kind: "boolean", value: selection.booleanValue }
                            : { configId: selection.configId, kind: "select", value: selection.value },
                    );
                    refresh(signal);
                    set({ change: { kind: "idle" } });
                } catch (cause) {
                    signal.throwIfAborted();
                    // The closed Session's notice says all there is to say about the change.
                    if (isSessionClosedFailure(cause)) {
                        set({ change: { kind: "idle" } });
                        return;
                    }
                    if (cause instanceof MortyApiError && cause.code === "session_configuration_conflict") {
                        refresh(signal);
                    }
                    set({
                        change: { kind: "failed", message: formatError(cause, "The selection could not be applied.") },
                    });
                }
            },
        };
    });
}
