import { MortyApiError, MortyOperationError } from "@portalcrew/morty-client";
import type {
    NativeSessionTarget,
    SessionConfigOption,
    SessionConfigurationSelection,
} from "@portalcrew/morty-client/protocol";
import { createStore } from "zustand/vanilla";
import { rememberAgentSettingChoice } from "../../services/chat/last-agent-settings.ts";
import { recordBrowserError } from "../../services/diagnostics/browser-diagnostics.ts";
import { formatError, isSessionClosedFailure } from "../format-error.ts";
import type { SessionOperationConnection } from "./session-operation-connection.ts";
import type { OperationFailure } from "./session-operation-feedback.ts";

// Computer snapshots own current settings. Live updates and history reloads request a new
// snapshot; historical configuration events never become current settings. The revision
// travels with its snapshot and is sent only for explicit edits.

type ConfigurationSnapshot = {
    readonly configOptions: readonly SessionConfigOption[];
    readonly configurationRevision: string;
};

type SettingsChange = { readonly kind: "idle" } | { readonly kind: "configuring"; readonly configId: string };

export interface SessionSettingsStore {
    readonly openedAt: string;
    readonly observedAt: string;
    readonly source: "session-ready" | "session-configuration";
    readonly configurationRevision: string;
    readonly options: readonly SessionConfigOption[];
    readonly change: SettingsChange;
    readonly opened: (snapshot: ConfigurationSnapshot) => void;
    readonly adopt: (snapshot: ConfigurationSnapshot) => void;
    /**
     * Refines the shown settings from an authoritative read, made whenever the
     * history is loaded again. The conversation stays usable while the
     * read runs, a Computer that cannot answer keeps the current settings, and settings adopted after the
     * read started win. A newer read replaces an unfinished one. Settles once this read, or the newer one that
     * replaced it, has settled; it never rejects.
     */
    readonly readInBackground: (
        read: (signal: AbortSignal) => Promise<ConfigurationSnapshot>,
        parentSignal: AbortSignal,
    ) => Promise<void>;
    readonly configure: (selection: SessionConfigurationSelection, signal: AbortSignal) => Promise<void>;
}

export function createSessionSettingsStore(options: {
    readonly computerId: string;
    readonly sessionTarget: NativeSessionTarget;
    readonly connection: SessionOperationConnection;
    readonly failed: (failure: OperationFailure) => void;
}) {
    return createStore<SessionSettingsStore>()((set, get) => {
        let pendingRead: { readonly controller: AbortController; readonly settled: Promise<void> } | null = null;
        const openedAt = new Date().toISOString();
        // A mutation response acknowledges the edit; it may already be older than another client's edit.
        // All refreshes use the same read lifetime so newer observations invalidate older reads.
        const refresh = (signal: AbortSignal): Promise<void> =>
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
                pendingRead?.controller.abort(new DOMException("The Session was opened again", "AbortError"));
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
                pendingRead?.controller.abort(new DOMException("Newer settings were adopted", "AbortError"));
                pendingRead = null;
                set({
                    options: configOptions,
                    configurationRevision,
                    observedAt: new Date().toISOString(),
                    source: "session-configuration",
                });
            },
            readInBackground: (read, parentSignal) => {
                pendingRead?.controller.abort(
                    new DOMException("A newer settings read replaced this one", "AbortError"),
                );
                const controller = new AbortController();
                const signal = AbortSignal.any([parentSignal, controller.signal, AbortSignal.timeout(45_000)]);
                const settled = read(signal)
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
                        if (pendingRead?.controller === controller) {
                            pendingRead = null;
                        }
                    })
                    .then(() => (pendingRead === null ? undefined : pendingRead.settled));
                pendingRead = { controller, settled };
                return settled;
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
                    rememberAgentSettingChoice(options.computerId, options.sessionTarget.harness, selection);
                    // The change ends once the page holds settings at or after the edit, so the next edit carries
                    // the revision this one produced.
                    await refresh(signal);
                    signal.throwIfAborted();
                    set({ change: { kind: "idle" } });
                } catch (cause) {
                    signal.throwIfAborted();
                    if (isSessionClosedFailure(cause)) {
                        set({ change: { kind: "idle" } });
                        return;
                    }
                    if (
                        (cause instanceof MortyApiError || cause instanceof MortyOperationError) &&
                        cause.code === "session_configuration_conflict"
                    ) {
                        await refresh(signal);
                        signal.throwIfAborted();
                    }
                    set({ change: { kind: "idle" } });
                    options.failed({
                        operation: "settings",
                        message: formatError(cause, "The selection could not be applied."),
                    });
                }
            },
        };
    });
}
