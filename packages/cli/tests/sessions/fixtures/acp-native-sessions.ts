import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { exitsAfterSessionCreation, persistsEmptySessions } from "../../support/acp-process.ts";
import { configOptions, sessionConfiguration } from "./acp-session-settings.ts";
import {
    acquireWriter,
    ControlledSessionState,
    nativeHistory,
    nativeMetadata,
    persistState,
    readPersistedState,
    readRecoveredState,
    releaseWriter,
    sessions,
} from "./acp-session-state.ts";

let listCommandsAnnounced = false;

/** The controlled harness owns allocation; independent harness stores have independent namespaces. */
function allocateSessionId(): string {
    const directory = process.env["MORTY_FAKE_ACP_STATE_DIRECTORY"];
    if (directory === undefined) {
        return crypto.randomUUID();
    }
    const allocations = join(directory, "native-session-allocations");
    mkdirSync(allocations, { recursive: true });
    for (let sequence = 1; sequence < 1_000_000_000_000; sequence += 1) {
        try {
            writeFileSync(join(allocations, String(sequence)), "", { flag: "wx" });
            return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
        } catch (cause) {
            if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) {
                throw cause;
            }
        }
    }
    throw new Error("Controlled harness native Session allocation is exhausted");
}

function projectModel(cwd: string): string | undefined {
    const path = join(cwd, ".claude", "settings.json");
    if (!existsSync(path)) {
        return undefined;
    }
    const model: unknown = Reflect.get(JSON.parse(readFileSync(path, "utf8")), "model");
    return typeof model === "string" ? model : undefined;
}

export function registerNativeSessions(agent: ReturnType<typeof acp.agent>) {
    return agent
        .onRequest(acp.methods.agent.session.new, async (context) => {
            if (process.argv.includes("--authentication-required")) {
                throw acp.RequestError.authRequired();
            }
            const sessionId = allocateSessionId();
            acquireWriter(sessionId);
            const state = new ControlledSessionState(0, projectModel(context.params.cwd));
            nativeMetadata.set(sessionId, {
                cwd: context.params.cwd,
                title: "",
            });
            sessions.set(sessionId, state);
            if (persistsEmptySessions()) {
                persistState(sessionId, state);
            }
            if (process.argv.includes("--announce-newer-settings-while-creating")) {
                const updated = state.withConfig("model", "test-large").withConfig("fast_mode", true).withMode("plan");
                sessions.set(sessionId, updated);
                persistState(sessionId, updated);
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId,
                    update: { sessionUpdate: "config_option_update", configOptions: configOptions(updated) },
                });
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId,
                    update: { sessionUpdate: "current_mode_update", currentModeId: updated.mode },
                });
            }
            if (process.argv.includes("--announce-config-while-creating")) {
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId: process.argv.includes("--announce-wrong-session-while-creating")
                        ? "unexpected-native-session"
                        : sessionId,
                    update: {
                        configOptions: configOptions(state),
                        sessionUpdate: "config_option_update",
                    },
                });
            }
            if (process.argv.includes("--announce-title-while-creating")) {
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId,
                    update: { sessionUpdate: "session_info_update", title: "Harness-created conversation" },
                });
            }
            if (exitsAfterSessionCreation()) {
                setImmediate(() => process.exit(0));
            }
            return {
                ...sessionConfiguration(state),
                sessionId,
            };
        })
        .onRequest(acp.methods.agent.session.resume, (context) => {
            acquireWriter(context.params.sessionId);
            const state = readRecoveredState(context.params.sessionId);
            sessions.set(context.params.sessionId, state);
            return sessionConfiguration(state);
        })
        .onRequest(acp.methods.agent.session.list, async (context) => {
            const directory = process.env["MORTY_FAKE_ACP_STATE_DIRECTORY"];
            const crash = directory === undefined ? undefined : join(directory, "crash-next-list");
            if (crash !== undefined && existsSync(crash)) {
                unlinkSync(crash);
                process.exit(1);
            }
            if (process.argv.includes("--announce-commands-while-listing") && !listCommandsAnnounced) {
                const activeSessionId = sessions.keys().next().value ?? "native-browser-notification";
                listCommandsAnnounced = true;
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId: activeSessionId,
                    update: {
                        availableCommands: [
                            {
                                description: "Inspect the current workspace",
                                input: { hint: "optional focus" },
                                name: "inspect",
                            },
                        ],
                        sessionUpdate: "available_commands_update",
                    },
                });
            }
            const stored =
                directory === undefined
                    ? [...sessions.entries()]
                    : readdirSync(directory)
                          .filter((name) => name.endsWith(".json"))
                          .map((name) => {
                              const id = decodeURIComponent(name.slice(0, -5));
                              return [id, readPersistedState(id)] satisfies readonly [string, ControlledSessionState];
                          });
            const candidates = stored
                .flatMap(([id, state]) => {
                    const metadata = nativeMetadata.get(id);
                    return state.turnCount === 0 ||
                        metadata === undefined ||
                        (context.params.cwd != null && context.params.cwd !== metadata.cwd)
                        ? []
                        : [
                              {
                                  sessionId: id,
                                  cwd: metadata.cwd,
                                  title: process.argv.includes("--untitled-native-sessions")
                                      ? null
                                      : process.argv.includes("--oversized-native-session-title")
                                        ? `${metadata.title}${"x".repeat(600)}`
                                        : metadata.title,
                                  updatedAt: "2026-09-05T00:00:00Z",
                              },
                          ];
                })
                .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
            const start = context.params.cursor == null ? 0 : Number(context.params.cursor);
            if (!Number.isSafeInteger(start) || start < 0) {
                throw new Error("Invalid native session cursor");
            }
            return {
                sessions: candidates.slice(start, start + 2),
                ...(start + 2 < candidates.length ? { nextCursor: String(start + 2) } : {}),
            };
        })
        .onRequest(acp.methods.agent.session.fork, (context) => {
            const state = readPersistedState(context.params.sessionId);
            const metadata = nativeMetadata.get(context.params.sessionId);
            if (metadata === undefined) {
                throw new Error("Unknown native session");
            }
            const sessionId = process.argv.includes("--reuse-session-on-fork")
                ? context.params.sessionId
                : crypto.randomUUID();
            acquireWriter(sessionId);
            nativeMetadata.set(sessionId, {
                ...metadata,
                cwd: context.params.cwd,
            });
            const sourceHistory = nativeHistory.get(context.params.sessionId) ?? [];
            const forkHistory = [...sourceHistory];
            const turns = forkHistory.filter((message) => message.role === "assistant").length;
            const forkedState = process.argv.includes("--reset-fork-settings")
                ? new ControlledSessionState(turns)
                : state.withTurnCount(turns);
            nativeHistory.set(sessionId, forkHistory);
            sessions.set(sessionId, forkedState);
            persistState(sessionId, forkedState);
            return {
                ...(process.argv.includes("--fork-omits-mode")
                    ? { configOptions: configOptions(forkedState) }
                    : sessionConfiguration(forkedState)),
                ...(process.argv.includes("--fork-omits-model")
                    ? { configOptions: configOptions(forkedState).filter((option) => option.id !== "model") }
                    : {}),
                ...(process.argv.includes("--fork-mode-unavailable")
                    ? {
                          modes: {
                              availableModes: [
                                  { id: "code", name: "Code" },
                                  { id: "review", name: "Review" },
                              ],
                              currentModeId: "code",
                          },
                      }
                    : {}),
                sessionId,
            };
        })
        .onRequest(acp.methods.agent.session.delete, (context) => {
            acquireWriter(context.params.sessionId);
            const directory = process.env["MORTY_FAKE_ACP_STATE_DIRECTORY"];
            if (directory !== undefined) {
                unlinkSync(join(directory, `${encodeURIComponent(context.params.sessionId)}.json`));
            }
            sessions.delete(context.params.sessionId);
            nativeMetadata.delete(context.params.sessionId);
            releaseWriter(context.params.sessionId);
            return {};
        })
        .onRequest(
            "_session/rename",
            (params: unknown) => params,
            (context) => {
                const params = context.params;
                if (
                    typeof params !== "object" ||
                    params === null ||
                    !("sessionId" in params) ||
                    typeof params.sessionId !== "string" ||
                    !("title" in params) ||
                    typeof params.title !== "string" ||
                    params.title.trim().length === 0
                ) {
                    throw new Error("Invalid controlled Agent rename request");
                }
                const metadata = nativeMetadata.get(params.sessionId);
                if (metadata === undefined) {
                    throw new Error("Unknown native session");
                }
                const state = sessions.get(params.sessionId) ?? readPersistedState(params.sessionId);
                nativeMetadata.set(params.sessionId, { ...metadata, title: params.title });
                persistState(params.sessionId, state);
                return {};
            },
        );
}
