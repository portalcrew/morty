import { decodeIdentifier, type Identifier } from "@portalcrew/morty-client/protocol";
import {
    type ChatAgentSelection,
    type ChatComputer,
    connectedChatComputerAgents,
} from "../../services/chat/bot-chat-api.ts";

export type NativeSessionAgent = ChatAgentSelection & { readonly installed: boolean };

const PI_HARNESS: Identifier = decodeIdentifier("pi");

/** Computer harness tabs: connected agents plus Pi when it is not on the Computer. */
export function nativeSessionAgentTabs(computer: ChatComputer): readonly NativeSessionAgent[] {
    const connected = connectedChatComputerAgents(computer);
    const installed = connected.map((agent) => ({
        ...agent,
        installed: true as const,
    }));
    if (connected.length === 0 || connected.some((agent) => agent.harness === PI_HARNESS)) {
        return installed;
    }
    return [
        ...installed,
        {
            harness: PI_HARNESS,
            label: "Pi",
            installed: false,
        },
    ];
}

/** A harness the configuration menu offers, as the Computer configuration names it. */
export interface HarnessOption {
    readonly installed: boolean;
    readonly label: string;
    /** The harness identifier. */
    readonly value: string;
}

/** The harnesses a configuration menu offers, derived from the Computer configuration the page follows. */
export function harnessOptions(computer: ChatComputer | null): readonly HarnessOption[] {
    return (computer === null ? [] : nativeSessionAgentTabs(computer)).map((agent) => ({
        installed: agent.installed,
        label: agent.label,
        value: agent.harness,
    }));
}

/** Existing sessions keep their Agent even if the Computer no longer offers it. */
export function sessionHarnessSelection(computer: ChatComputer | null, harness: string) {
    const options = harnessOptions(computer);
    const selected = options.find((option) => option.value === harness);
    if (selected !== undefined) {
        return { options, value: selected.value };
    }
    const fallback: HarnessOption = {
        installed: false,
        label: harness,
        value: harness,
    };
    return { options: [...options, fallback], value: fallback.value };
}
