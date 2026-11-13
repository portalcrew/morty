import { createStore } from "zustand/vanilla";
import type { ApiTransport } from "../../services/api/api-transport.ts";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import { type AnonymousIdentity, AnonymousIdentityApi } from "../../services/identity/anonymous-identity-api.ts";
import type { IdentityScope } from "../../services/identity/identity-scope-url.ts";
import {
    computerKey,
    rememberComputerName,
    rememberedComputers,
    resumeComputerAddress,
} from "../../services/identity/remembered-computers.ts";
import type { BotConnectionStatus } from "./computer-status-store.ts";

export interface ComputerChoice {
    readonly key: string;
    readonly name: string;
    readonly href: string;
    readonly status: "online" | "offline" | "unavailable" | "connecting" | "unpaired" | "revoked";
}

type RememberedComputerChoice = Omit<ComputerChoice, "status"> &
    ({ readonly kind: "current" } | { readonly kind: "other"; readonly status: "online" | "offline" | "unavailable" });

type ComputerChoicesState =
    | { readonly kind: "loading"; readonly choices: readonly RememberedComputerChoice[] }
    | { readonly kind: "ready"; readonly choices: readonly RememberedComputerChoice[] };

/** The current computer follows home directly; only other computers need independent status reads. */
export function computerSwitcherChoices(
    state: ComputerChoicesState,
    name: string,
    connection: BotConnectionStatus,
): readonly ComputerChoice[] {
    return state.choices
        .map((choice): ComputerChoice => {
            if (choice.kind === "other") {
                return choice;
            }
            return {
                key: choice.key,
                href: choice.href,
                name: name || choice.name,
                status:
                    connection.kind === "connected"
                        ? "online"
                        : connection.kind === "disconnected"
                          ? "offline"
                          : connection.kind,
            };
        })
        .sort((left, right) => left.name.localeCompare(right.name) || left.key.localeCompare(right.key));
}

export type ComputerSwitcherModel = ReturnType<typeof createComputerSwitcher>;

export function createComputerSwitcher(options: {
    readonly active: IdentityScope;
    readonly origin: string;
    readonly fetchRequest: ApiTransport["fetch"];
    readonly requests: (identity: AnonymousIdentity) => BotChatApi;
}) {
    const api = new AnonymousIdentityApi(options);
    const store = createStore<ComputerChoicesState>(() => ({ kind: "loading", choices: [] }));
    const activeKey = computerKey(options.active);
    let attempt: AbortController | null = null;
    let disposed = false;
    return {
        store,
        activeKey,
        refresh: async (): Promise<void> => {
            if (disposed) {
                return;
            }
            attempt?.abort(new DOMException("Computer list refresh replaced", "AbortError"));
            const controller = new AbortController();
            attempt = controller;
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
            store.setState((state) => ({ kind: "loading", choices: state.choices }));
            try {
                const choices = await Promise.all(
                    rememberedComputers().map(async (computer): Promise<RememberedComputerChoice | null> => {
                        const address = {
                            key: computerKey(computer.scope),
                            name: computer.name || "Computer",
                            href: resumeComputerAddress(computer.scope, computer.destination),
                        };
                        if (address.key === activeKey) {
                            return { ...address, kind: "current" };
                        }
                        const choice: RememberedComputerChoice = {
                            ...address,
                            kind: "other",
                            status: "unavailable",
                        };
                        try {
                            const identity = await api.loadScope(computer.scope, signal);
                            signal.throwIfAborted();
                            if (identity === null) {
                                return null;
                            }
                            const requests = options.requests(identity);
                            try {
                                const pairing = await requests.readComputerPairing(signal);
                                signal.throwIfAborted();
                                if (pairing !== "paired") {
                                    return choice;
                                }
                                const configuration = await requests.computerConfiguration(signal);
                                signal.throwIfAborted();
                                rememberComputerName(identity, configuration.computer.computerName);
                                return {
                                    ...choice,
                                    name: configuration.computer.computerName || choice.name,
                                    status: configuration.computer.online ? "online" : "offline",
                                };
                            } finally {
                                requests.close();
                            }
                        } catch {
                            controller.signal.throwIfAborted();
                            // An unavailable service is not evidence that access ended.
                            return choice;
                        }
                    }),
                );
                controller.signal.throwIfAborted();
                store.setState({ kind: "ready", choices: choices.filter((choice) => choice !== null) });
            } catch {
                if (!controller.signal.aborted) {
                    store.setState((state) => ({ kind: "ready", choices: state.choices }));
                }
            } finally {
                if (attempt === controller) {
                    attempt = null;
                }
            }
        },
        dispose: () => {
            disposed = true;
            attempt?.abort(new DOMException("Computer switcher disposed", "AbortError"));
            attempt = null;
        },
    };
}
