import { isBoundedJson } from "@portalcrew/morty-client/protocol";
import { z } from "zod";

const toolEventSchema = z.looseObject({
    sessionUpdate: z.enum(["tool_call", "tool_call_update"]),
    rawInput: z.unknown().optional(),
    rawOutput: z.unknown().optional(),
});
const TRUNCATED_TOOL_PAYLOAD_CHARACTER_LIMIT = 32_768;
const MAX_TOOL_PAYLOAD_DEPTH = 16;

function payloadText(value: unknown): string {
    let text: string;
    try {
        text = JSON.stringify(value) ?? "";
    } catch {
        text = "Tool payload could not be represented as JSON.";
    }
    return text.slice(0, TRUNCATED_TOOL_PAYLOAD_CHARACTER_LIMIT);
}

function fitNesting(value: unknown, depth = 0): unknown {
    if (typeof value !== "object" || value === null) {
        return value;
    }
    if (depth === MAX_TOOL_PAYLOAD_DEPTH && Object.keys(value).length > 0) {
        // A string at this depth remains valid for both media extraction and SDK decoding.
        return `[truncated: nesting depth] ${payloadText(value)}`;
    }
    if (Array.isArray(value)) {
        return value.map((child) => fitNesting(child, depth + 1));
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, fitNesting(child, depth + 1)]));
}

/** Protect the media walk without discarding extractable images in shallower branches. */
export function prepareCodexToolUpdate(update: SessionUpdate): SessionUpdate {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
        return update;
    }
    return {
        ...update,
        ...(update.rawOutput === undefined ? {} : { rawOutput: fitNesting(update.rawOutput) }),
        ...(update._meta == null
            ? {}
            : {
                  _meta: Object.fromEntries(
                      Object.entries(update._meta).map(([key, child]) => [key, fitNesting(child, 1)]),
                  ),
              }),
    };
}

function fitPayload(value: unknown): unknown {
    if (value === undefined || isBoundedJson(value)) {
        return value;
    }
    return { truncated: true, text: payloadText(value) };
}

export function fitCodexToolEvent(event: unknown): unknown {
    const decoded = toolEventSchema.safeParse(event);
    if (!decoded.success) {
        return event;
    }
    return {
        ...decoded.data,
        rawInput: fitPayload(decoded.data.rawInput),
        rawOutput: fitPayload(decoded.data.rawOutput),
    };
}

import type { SessionUpdate } from "@agentclientprotocol/sdk/unstable";
