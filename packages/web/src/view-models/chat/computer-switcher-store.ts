import { createStore } from "zustand/vanilla";
import type { ApiTransport } from "../../services/api/api-transport.ts";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import { type AnonymousIdentity, AnonymousIdentityApi } from "../../services/identity/anonymous-identity-api.ts";
import type { IdentityScope } from "../../services/identity/identity-scope-url.ts";
import {
    computerKey,
    forgetRememberedComputer,
    rememberComputerName,
    rememberedComputers,
    resumeComputerAddress,
} from "../../services/identity/remembered-computers.ts";
import type { BotConnectionStatus } from "./computer-status-store.ts";

interface ComputerConnectionChoice {
    readonly key: string;
    readonly name: string;
    readonly href: string;
    readonly status: "online" | "offline" | "unavailable" | "connecting" | "unpaired" | "revoked";
}

export type ComputerChoice = ComputerConnectionChoice & { readonly disambiguator: string | null };

type RememberedComputerChoice = Omit<ComputerConnectionChoice, "status"> &
    (
        | { readonly kind: "current" }
        | { readonly kind: "other"; readonly status: Exclude<ComputerConnectionChoice["status"], "connecting"> }
    );

type ComputerChoicesState =
    | { readonly kind: "loading"; readonly choices: readonly RememberedComputerChoice[] }
    | { readonly kind: "ready"; readonly choices: readonly RememberedComputerChoice[] };

/**
 * Removing a computer forgets this browser's only access to it, so the list offers removal only while the person edits
 * it, and the person confirms each removal.
 */
type ComputerRemoval =
    | { readonly kind: "none" }
    | { readonly kind: "editing" }
    | { readonly kind: "confirming"; readonly key: string };

/** The current computer follows home directly; only other computers need independent status reads. */
export function computerSwitcherChoices(
    state: ComputerChoicesState,
    name: string,
    connection: BotConnectionStatus,
): readonly ComputerChoice[] {
    const choices = state.choices
        .map((choice): ComputerConnectionChoice => {
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
    return choices.map((choice) => ({ ...choice, disambiguator: computerChoiceDisambiguator(choice, choices) }));
}

function computerChoiceDisambiguator(
    choice: ComputerConnectionChoice,
    choices: readonly ComputerConnectionChoice[],
): string | null {
    const others = choices.filter((other) => other.name === choice.name && other.key !== choice.key);
    if (others.length === 0) {
        return null;
    }
    let length = 6;
    while (length < choice.key.length && others.some((other) => other.key.endsWith(choice.key.slice(-length)))) {
        length += 1;
    }
    return `ID ${choice.key.slice(-length)}`;
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
    const removal = createStore<ComputerRemoval>(() => ({ kind: "none" }));
    const activeKey = computerKey(options.active);
    const lifetime = new AbortController();
    let attempt: AbortController | null = null;
    return {
        store,
        activeKey,
        refresh: async (): Promise<void> => {
            if (lifetime.signal.aborted) {
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
                                    return { ...choice, status: pairing };
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
                // A computer forgotten while its status was being read stays forgotten.
                const remembered = new Set(rememberedComputers().map((computer) => computerKey(computer.scope)));
                store.setState({
                    kind: "ready",
                    choices: choices.filter((choice) => choice !== null).filter((choice) => remembered.has(choice.key)),
                });
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
        removal,
        startEditing: (): void => {
            if (removal.getState().kind === "none") {
                removal.setState({ kind: "editing" });
            }
        },
        stopEditing: (): void => {
            if (removal.getState().kind === "editing") {
                removal.setState({ kind: "none" });
            }
        },
        /** The computer this page is on cannot be forgotten from here. */
        requestRemoval: (key: string): void => {
            if (removal.getState().kind === "editing" && key !== activeKey) {
                removal.setState({ kind: "confirming", key });
            }
        },
        cancelRemoval: (): void => {
            removal.setState({ kind: "none" });
        },
        confirmRemoval: async (): Promise<void> => {
            const pending = removal.getState();
            removal.setState({ kind: "none" });
            if (pending.kind !== "confirming") {
                return;
            }
            const key = pending.key;
            const computer = rememberedComputers().find((candidate) => computerKey(candidate.scope) === key);
            if (computer === undefined) {
                return;
            }
            try {
                await forgetRememberedComputer(computer.scope, lifetime.signal);
            } catch {
                // A computer this browser could not forget stays listed.
                return;
            }
            store.setState((state) => ({ ...state, choices: state.choices.filter((choice) => choice.key !== key) }));
        },
        dispose: () => {
            lifetime.abort(new DOMException("Computer switcher disposed", "AbortError"));
            attempt?.abort(new DOMException("Computer switcher disposed", "AbortError"));
            attempt = null;
        },
    };
}
