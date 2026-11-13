// Modified for Morty.
// Part of the Claude ACP adapter derived from Zed Industries' claude-code-acp (Apache-2.0).

import {
    getSessionMessages,
    importSessionToStore,
    type SessionMessage,
    type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { withDeadline, withEnvironment } from "./utils.js";

export type EnvironmentSessionMessage = SessionMessage & {
    readonly nativeOrigin?: unknown;
    readonly nativeToolUseResult?: unknown;
    readonly nativeCompaction?:
        | { readonly kind: "boundary"; readonly id: string }
        | { readonly kind: "summary"; readonly id: string };
};

const SESSION_MESSAGES_TIMEOUT_MILLISECONDS = 30_000;

/**
 * Read a session's message history under `environment`.
 *
 * The SDK is called in-process rather than resolved to a module URL and loaded
 * inside a worker: when this Agent is bundled into a single CJS entry there is
 * no installable package left on disk for a worker to import, so a dynamic
 * `import(specifier)` cannot resolve it. The environment the worker used to carry
 * is applied by {@link withEnvironment} instead.
 */
export function getEnvironmentSessionMessages(
    environment: Readonly<NodeJS.ProcessEnv>,
    sessionId: string,
    cancellationSignal: AbortSignal,
): Promise<readonly EnvironmentSessionMessage[]> {
    const signal = AbortSignal.any([cancellationSignal, AbortSignal.timeout(SESSION_MESSAGES_TIMEOUT_MILLISECONDS)]);
    return withEnvironment(environment, () =>
        withDeadline(signal, SESSION_MESSAGES_TIMEOUT_MILLISECONDS, async () => {
            // The SDK projection omits native provenance, structured tool results, and error categories.
            // Import once, then project from memory. Never classify a diagnostic
            // by its human-readable text.
            const authenticationFailures = new Set<string>();
            const transcript: SessionStoreEntry[] = [];
            const nativeMetadata = new Map<
                string,
                { readonly nativeOrigin?: unknown; readonly nativeToolUseResult?: unknown }
            >();
            await importSessionToStore(
                sessionId,
                {
                    append: async (_key, entries) => {
                        signal.throwIfAborted();
                        transcript.push(...entries);
                        for (const entry of entries) {
                            if (entry.type === "user" && typeof entry.uuid === "string") {
                                nativeMetadata.set(entry.uuid, {
                                    nativeOrigin: entry["origin"],
                                    nativeToolUseResult: entry["toolUseResult"],
                                });
                            }
                            if (
                                entry.type === "assistant" &&
                                entry["error"] === "authentication_failed" &&
                                typeof entry.uuid === "string"
                            ) {
                                authenticationFailures.add(entry.uuid);
                            }
                        }
                    },
                    load: async () => null,
                },
                { includeSubagents: false },
            );
            signal.throwIfAborted();
            const messages =
                (await readFullHistory(transcript, sessionId, signal)) ?? (await getSessionMessages(sessionId));
            return messages
                .filter((message) => !authenticationFailures.has(message.uuid))
                .map((message) => ({ ...message, ...nativeMetadata.get(message.uuid) }));
        }),
    );
}

const chainEntrySchema = z
    .object({
        type: z.enum(["user", "assistant", "system", "progress", "attachment"]),
        uuid: z.string(),
        parentUuid: z.string().nullable(),
        logicalParentUuid: z.string().nullable().optional(),
        subtype: z.string().optional(),
        isCompactSummary: z.boolean().optional(),
        compactMetadata: z
            .object({
                preservedSegment: z
                    .object({ headUuid: z.string(), tailUuid: z.string(), anchorUuid: z.string() })
                    .optional(),
                preservedMessages: z.object({ uuids: z.array(z.string()), anchorUuid: z.string() }).optional(),
            })
            .passthrough()
            .optional(),
    })
    .passthrough();

/** The SDK still owns branch selection, preserved-segment reattachment and
 * split assistant/tool-result recovery. Project each pre-compaction chain from
 * the same imported transcript, before later compactions can reparent it. */
async function readFullHistory(
    transcript: readonly SessionStoreEntry[],
    sessionId: string,
    signal: AbortSignal,
): Promise<readonly EnvironmentSessionMessage[] | null> {
    const entries = new Map<string, { readonly entry: z.infer<typeof chainEntrySchema>; readonly index: number }>();
    for (const [index, raw] of transcript.entries()) {
        signal.throwIfAborted();
        if (typeof raw.uuid !== "string") {
            continue;
        }
        if (!["user", "assistant", "system", "progress", "attachment"].includes(raw.type)) {
            continue;
        }
        const parsed = chainEntrySchema.safeParse(raw);
        if (!parsed.success) {
            return null;
        }
        entries.set(parsed.data.uuid, { entry: parsed.data, index });
    }
    // Reject broken links/cycles rather than accepting the SDK's truncated chain.
    const validated = new Set<string>();
    for (const uuid of entries.keys()) {
        signal.throwIfAborted();
        const visiting = new Set<string>();
        let current: string | null = uuid;
        while (current !== null && !validated.has(current)) {
            const node = entries.get(current);
            if (node === undefined || visiting.has(current)) {
                return null;
            }
            visiting.add(current);
            const entry = node.entry;
            current =
                entry.subtype === "compact_boundary" ? (entry.logicalParentUuid ?? entry.parentUuid) : entry.parentUuid;
        }
        for (const id of visiting) {
            validated.add(id);
        }
    }
    for (const { entry } of entries.values()) {
        if (entry.subtype !== "compact_boundary") {
            continue;
        }
        const preserved = entry.compactMetadata;
        const references =
            preserved?.preservedMessages !== undefined
                ? [...preserved.preservedMessages.uuids, preserved.preservedMessages.anchorUuid]
                : preserved?.preservedSegment !== undefined
                  ? [
                        preserved.preservedSegment.headUuid,
                        preserved.preservedSegment.tailUuid,
                        preserved.preservedSegment.anchorUuid,
                    ]
                  : [];
        if (references.some((id) => !entries.has(id))) {
            return null;
        }
    }
    const project = async (source: SessionStoreEntry[]) => {
        signal.throwIfAborted();
        const messages = await getSessionMessages(sessionId, {
            includeSystemMessages: true,
            sessionStore: { append: async () => {}, load: async () => source },
        });
        signal.throwIfAborted();
        return messages;
    };
    const result: EnvironmentSessionMessage[] = [];
    const seen = new Set<string>();
    const expanding = new Set<string>();
    const append = async (messages: readonly SessionMessage[]): Promise<boolean> => {
        let compactionId: string | undefined;
        for (const message of messages) {
            signal.throwIfAborted();
            const node = entries.get(message.uuid);
            if (node === undefined) {
                return false;
            }
            if (node.entry.subtype === "compact_boundary") {
                compactionId = message.uuid;
                if (seen.has(message.uuid)) {
                    continue;
                }
                if (expanding.has(message.uuid)) {
                    return false;
                }
                expanding.add(message.uuid);
                const parent = node.entry.logicalParentUuid;
                if (typeof parent === "string") {
                    const ancestor = entries.get(parent);
                    if (ancestor === undefined || ancestor.index >= node.index) {
                        return false;
                    }
                    // A synthetic leaf selects exactly the logical parent, not an
                    // unrelated branch written later in this transcript prefix.
                    const anchor = `history-anchor-${message.uuid}`;
                    if (entries.has(anchor)) {
                        return false;
                    }
                    const earlier = await project([
                        ...transcript.slice(0, node.index),
                        {
                            type: "user",
                            uuid: anchor,
                            parentUuid: parent,
                            sessionId,
                            message: { role: "user", content: "" },
                        },
                    ]);
                    if (!(await append(earlier.filter((entry) => entry.uuid !== anchor)))) {
                        return false;
                    }
                }
                expanding.delete(message.uuid);
                seen.add(message.uuid);
                result.push({ ...message, nativeCompaction: { kind: "boundary", id: message.uuid } });
            } else if (!seen.has(message.uuid)) {
                seen.add(message.uuid);
                if (node.entry.isCompactSummary === true) {
                    if (compactionId === undefined) {
                        return false;
                    }
                    result.push({ ...message, nativeCompaction: { kind: "summary", id: compactionId } });
                } else if (message.type !== "system") {
                    result.push(message);
                }
            }
        }
        return true;
    };
    return (await append(await project([...transcript]))) ? result : null;
}
