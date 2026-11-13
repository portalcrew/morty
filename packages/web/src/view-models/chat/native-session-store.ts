import type { NativeSessionEntry, NativeSessionResult } from "@morty-build/client/protocol";
import { createStore } from "zustand/vanilla";
import type { BotChatApi, ChatComputer, ManagedChatSession } from "../../services/chat/bot-chat-api.ts";
import { formatError } from "../format-error.ts";
import { type NativeSessionAgent, nativeSessionAgentTabs } from "./native-session-agents.ts";
import type { OpenMortySession } from "./open-session.ts";
import { type SessionMessage, sessionEventLogPresentation } from "./session-presentation.ts";

type NativeSessionDirectory =
    | {
          readonly kind: "loading";
          readonly scope: "initial" | "refresh";
          /** The listing the request in flight is for, or null while the page waits for the Computer. */
          readonly listing: string | null;
      }
    | { readonly kind: "empty" }
    | {
          readonly kind: "ready";
          readonly harness: string;
          readonly capabilities: Extract<NativeSessionResult, { readonly action: "list" }>["capabilities"];
          readonly entries: readonly NativeSessionEntry[];
          readonly nextCursor: string | null;
      }
    | { readonly kind: "failed"; readonly message: string }
    | { readonly kind: "agent-unavailable"; readonly agentLabel: string };

type NativeSessionPreview =
    | { readonly kind: "empty" }
    | { readonly kind: "loading"; readonly entry: NativeSessionEntry }
    | {
          readonly kind: "ready";
          readonly entry: NativeSessionEntry;
          readonly content: {
              readonly messages: readonly SessionMessage[];
              readonly truncated: boolean;
          };
      }
    | { readonly kind: "failed"; readonly entry: NativeSessionEntry; readonly message: string };

type Operation = "idle" | "more" | "import" | "fork";

type ForkIntent = {
    readonly target: string;
    readonly operationId: string;
};

export interface NativeSessionStore {
    /** The agent tab the user chose, by harness; the tabs themselves come from the Computer configuration. */
    readonly selected: string;
    readonly directory: NativeSessionDirectory;
    readonly preview: NativeSessionPreview;
    readonly operation: Operation;
    readonly forkIntent: ForkIntent | null;
    readonly error: string;
    /** Starts discovery when the dialog opens. */
    readonly start: () => void;
    /** The signal of the dialog's discovery lifetime. */
    readonly lifetimeSignal: () => AbortSignal;
    /** Stops discovery and preview requests when the dialog closes. */
    readonly stop: () => void;
    readonly load: (signal: AbortSignal) => Promise<void>;
    /** The Computer configuration the page follows changed: the listing follows the agent it now offers. */
    readonly computerChanged: () => void;
    readonly selectAgent: (value: string) => void;
    readonly select: (entry: NativeSessionEntry, signal: AbortSignal) => Promise<void>;
    readonly open: (action: "import" | "fork", signal: AbortSignal) => Promise<void>;
    readonly more: (signal: AbortSignal) => Promise<void>;
    readonly dispose: () => void;
}

/** Linked native entries use the same current Session titles as the sidebar, without caching a presentation. */
export function nativeSessionPresentation(model: NativeSessionStore, sessions: readonly ManagedChatSession[]) {
    const present = (entry: NativeSessionEntry) => {
        const linked = sessions.filter(
            (session) =>
                model.directory.kind === "ready" &&
                session.target.harness === model.directory.harness &&
                session.target.sessionId === entry.sessionId &&
                session.title.trim().length > 0,
        );
        return { ...entry, displayTitle: linked[0]?.title ?? (entry.title || "Untitled session") };
    };
    return {
        ...model,
        directory:
            model.directory.kind === "ready"
                ? { ...model.directory, entries: model.directory.entries.map(present) }
                : model.directory,
        preview:
            model.preview.kind === "empty" ? model.preview : { ...model.preview, entry: present(model.preview.entry) },
    };
}

/** The agent tab a listing is for: the chosen tab while the Computer still offers it, else the first installed one. */
function chosenAgent(agents: readonly NativeSessionAgent[], selected: string): NativeSessionAgent | undefined {
    return agents.find((item) => item.harness === selected) ?? agents.find((item) => item.installed) ?? agents[0];
}

/**
 * The listed entry a relisting should keep previewing: the one the user was reading, recognised across
 * listings by its harness-owned Session ID within the selected Agent.
 */
function relistMatch(
    entries: readonly NativeSessionEntry[],
    previewed: NativeSessionEntry | null,
): NativeSessionEntry | undefined {
    if (previewed === null) {
        return undefined;
    }
    return entries.find((entry) => entry.sessionId === previewed.sessionId);
}

/** What a listing shows for an agent, to tell whether the Computer configuration still matches it. */
function listingFor(agent: NativeSessionAgent | undefined): string {
    return agent === undefined ? "empty" : `${agent.installed ? "ready" : "agent-unavailable"}:${agent.harness}`;
}

export const createNativeSessionStore = (
    requests: Pick<BotChatApi, "nativeSessions" | "nativeSession" | "forkNativeSession">,
    /** The Computer the page follows, the one owner of which agents it offers. */
    computer: () => ChatComputer | null,
    onOpen: (session: OpenMortySession) => void,
) => {
    let selection: AbortController | null = null;
    let discovery: AbortController | null = null;
    const lifetime = new AbortController();
    return createStore<NativeSessionStore>()((set, get) => ({
        start: () => {
            void get().load(lifetime.signal);
        },
        lifetimeSignal: () =>
            discovery === null ? lifetime.signal : AbortSignal.any([lifetime.signal, discovery.signal]),
        stop: () => {
            lifetime.abort(new Error("The native session dialog closed."));
            get().dispose();
        },
        selected: "",
        directory: { kind: "loading", scope: "initial", listing: null },
        preview: { kind: "empty" },
        operation: "idle",
        forkIntent: null,
        error: "",
        load: async (parent) => {
            const current = computer();
            const agent = current === null ? undefined : chosenAgent(nativeSessionAgentTabs(current), get().selected);
            const listing = current === null ? null : listingFor(agent);
            const before = get().directory;
            // The Computer runs one native session operation per agent at a time: a request it is still carrying
            // out answers for this listing too, and cancelling it to send the same request again would only be
            // refused as busy.
            if (listing !== null && before.kind === "loading" && before.listing === listing) {
                return;
            }
            // A new listing invalidates the selected preview, including its in-flight response.
            selection?.abort();
            selection = null;
            const attempt = new AbortController();
            discovery?.abort(new Error("Native session discovery restarted."));
            discovery = attempt;
            const signal = AbortSignal.any([parent, attempt.signal]);
            const scope = get().selected === "" ? ("initial" as const) : ("refresh" as const);
            const previewed = get().preview;
            const previewedEntry = previewed.kind === "empty" ? null : previewed.entry;
            set({ directory: { kind: "loading", scope, listing }, preview: { kind: "empty" }, error: "" });
            if (current === null) {
                // The page has not heard from the Computer yet; its first configuration starts the listing.
                return;
            }
            try {
                if (agent === undefined) {
                    set({ directory: { kind: "empty" } });
                    return;
                }
                const selected = agent.harness;
                if (!agent.installed) {
                    set({
                        selected,
                        directory: { kind: "agent-unavailable", agentLabel: agent.label },
                        preview: { kind: "empty" },
                    });
                    return;
                }
                set({ selected });
                const result = await requests.nativeSessions(
                    {
                        action: "list",
                        harness: agent.harness,
                        directory: ".",
                        cursor: null,
                    },
                    signal,
                );
                signal.throwIfAborted();
                if (result.action !== "list") {
                    throw new Error("The agent returned an unexpected session directory.");
                }
                const entries = result.entries;
                set({
                    directory: {
                        kind: "ready",
                        harness: agent.harness,
                        capabilities: result.capabilities,
                        entries,
                        nextCursor: result.nextCursor,
                    },
                });
                // A listing always lands with a previewed session: the one the user was reading when it is still
                // listed, else its first entry. Opening the dialog and switching agent tabs would otherwise leave
                // the whole right pane empty even though there is a session to show.
                const next = relistMatch(entries, previewedEntry) ?? entries[0];
                if (next !== undefined) {
                    // The selection owns its request independently of the completed discovery attempt.
                    // Invalidating this listing ends that selection before the next listing is published.
                    void get().select(next, lifetime.signal);
                }
            } catch (cause) {
                if (!signal.aborted) {
                    set({
                        directory: {
                            kind: "failed",
                            message: formatError(cause, "Native sessions are unavailable."),
                        },
                    });
                }
            }
        },
        computerChanged: () => {
            const current = computer();
            // An Open, Fork or Load more the user sent keeps running: restarting discovery would cancel a request
            // the Computer may already be carrying out. Its end checks the listing against the configuration again.
            if (current === null || get().operation !== "idle") {
                return;
            }
            const { directory, selected } = get();
            const shown =
                directory.kind === "empty"
                    ? "empty"
                    : directory.kind === "agent-unavailable"
                      ? `agent-unavailable:${selected}`
                      : directory.kind === "ready"
                        ? `ready:${directory.harness}`
                        : directory.kind === "loading"
                          ? directory.listing
                          : null;
            if (shown !== listingFor(chosenAgent(nativeSessionAgentTabs(current), selected))) {
                void get().load(lifetime.signal);
            }
        },
        selectAgent: (selected) => {
            set({ selected });
            void get().load(lifetime.signal);
        },
        select: async (entry, lifetimeSignal) => {
            const { directory, operation, preview } = get();
            if (directory.kind !== "ready" || operation !== "idle") {
                return;
            }
            // Selecting the auto-selected entry again must retain its in-flight native read.
            // Cancelling and restarting it races the Computer's operation ownership.
            if (
                (preview.kind === "loading" || preview.kind === "ready") &&
                preview.entry.sessionId === entry.sessionId
            ) {
                return;
            }
            selection?.abort();
            selection = new AbortController();
            const signal = AbortSignal.any([selection.signal, lifetimeSignal]);
            set({ preview: { kind: "loading", entry }, error: "" });
            try {
                const content = await requests.nativeSession(
                    {
                        harness: directory.harness,
                        directory: entry.directory,
                        sessionId: entry.sessionId,
                    },
                    signal,
                );
                signal.throwIfAborted();
                const events = content.events.events;
                set({
                    preview: {
                        kind: "ready",
                        entry,
                        content: {
                            messages: sessionEventLogPresentation(events).messages,
                            truncated: content.events.nextCursor !== null,
                        },
                    },
                });
            } catch (cause) {
                if (!signal.aborted) {
                    set({
                        preview: {
                            kind: "failed",
                            entry,
                            message: formatError(cause, "The preview could not be loaded."),
                        },
                    });
                }
            }
        },
        open: async (action, signal) => {
            const { directory, preview, operation } = get();
            if (directory.kind !== "ready" || preview.kind !== "ready" || operation !== "idle") {
                return;
            }
            set({ operation: action, error: "" });
            try {
                const input = {
                    harness: directory.harness,
                    directory: preview.entry.directory,
                    sessionId: preview.entry.sessionId,
                };
                const retained = get().forkIntent;
                const target = JSON.stringify(input);
                const forkIntent =
                    retained !== null && retained.target === target
                        ? retained
                        : { target, operationId: crypto.randomUUID() };
                if (action === "fork") {
                    set({ forkIntent });
                }
                const result =
                    action === "fork"
                        ? await requests.forkNativeSession(forkIntent.operationId, input, signal)
                        : await requests.nativeSessions(
                              {
                                  action,
                                  harness: directory.harness,
                                  directory: preview.entry.directory,
                                  sessionId: preview.entry.sessionId,
                              },
                              signal,
                          );
                signal.throwIfAborted();
                if (result.action !== action) {
                    throw new Error(`This agent cannot ${action} the selected native session.`);
                }
                onOpen({
                    harness: directory.harness,
                    result,
                    entry: preview.entry,
                });
                // A successful open unmounts the dialog, so end the discovery
                // lifetime here; its close path never runs.
                get().stop();
            } catch (cause) {
                if (!signal.aborted) {
                    set({ error: formatError(cause, `The session could not be ${action}ed.`) });
                }
            } finally {
                if (!signal.aborted) {
                    set({ operation: "idle" });
                    get().computerChanged();
                }
            }
        },
        more: async (signal) => {
            const { directory, operation } = get();
            if (directory.kind !== "ready" || directory.nextCursor === null || operation !== "idle") {
                return;
            }
            set({ operation: "more", error: "" });
            try {
                const result = await requests.nativeSessions(
                    {
                        action: "list",
                        harness: directory.harness,
                        directory: ".",
                        cursor: directory.nextCursor,
                    },
                    signal,
                );
                signal.throwIfAborted();
                if (result.action !== "list") {
                    throw new Error("The agent returned an unexpected session directory.");
                }
                set({
                    directory: {
                        ...directory,
                        entries: [
                            ...directory.entries,
                            ...result.entries.filter(
                                (entry) =>
                                    !directory.entries.some((existing) => existing.sessionId === entry.sessionId),
                            ),
                        ],
                        nextCursor: result.nextCursor,
                    },
                });
            } catch (cause) {
                if (!signal.aborted) {
                    set({ error: formatError(cause, "More sessions could not be loaded.") });
                }
            } finally {
                if (!signal.aborted) {
                    set({ operation: "idle" });
                    get().computerChanged();
                }
            }
        },
        dispose: () => {
            selection?.abort();
            selection = null;
        },
    }));
};
