import { createHash } from "node:crypto";
import { z } from "zod";
import { AcpExecutionError } from "../../acp-error.ts";
import { resolveHistoryTextImages } from "../../native-history/codex/history-images.ts";
import { type CodexAppServerClient, CodexAppServerResponseTooLargeError } from "./app-server-client.ts";
import {
    CODEX_HISTORY_ITEM_PAGE_LIMIT,
    CODEX_HISTORY_TURN_PAGE_LIMIT,
    threadItemsPageSchema,
    threadTurnsPageSchema,
} from "./app-server-protocol.ts";
import { decodeThreadItem, messageQuestions, reasoningText, toolCallUpdate } from "./items.ts";
import { agentMessageUpdate } from "./owned-agent.ts";
import type { CodexSessionUpdate } from "./session-update.ts";

type TurnContent = { readonly kind: "item"; readonly item: unknown } | { readonly kind: "unreadable" };

interface SavedTurn {
    readonly id: string | undefined;
    readonly error: { readonly message: string } | null | undefined;
    readonly contents: readonly TurnContent[];
}

const itemIdentitySchema = z.object({ id: z.string() });

function repeatedCursor(): AcpExecutionError {
    return new AcpExecutionError("Codex repeated a history page cursor", {}, "invalid_native_session_response");
}

async function readItems(
    client: CodexAppServerClient,
    query: { readonly threadId: string; readonly turnId: string; readonly sortDirection: "asc" | "desc" },
    stopAt: ReadonlySet<string>,
    signal: AbortSignal,
): Promise<{ readonly items: readonly unknown[]; readonly complete: boolean }> {
    const items: unknown[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let limit = CODEX_HISTORY_ITEM_PAGE_LIMIT;
    for (;;) {
        signal.throwIfAborted();
        let page: z.infer<typeof threadItemsPageSchema>;
        try {
            page = threadItemsPageSchema.parse(
                await client.request(
                    "thread/items/list",
                    { ...query, limit, ...(cursor === null ? {} : { cursor }) },
                    signal,
                ),
            );
        } catch (error) {
            if (!(error instanceof CodexAppServerResponseTooLargeError)) {
                throw error;
            }
            if (limit === 1) {
                return { items, complete: false };
            }
            limit = 1;
            continue;
        }
        for (const { item } of page.data) {
            const identity = itemIdentitySchema.safeParse(item);
            if (identity.success && stopAt.has(identity.data.id)) {
                return { items, complete: true };
            }
            items.push(item);
        }
        if (page.nextCursor == null) {
            return { items, complete: true };
        }
        if (page.data.length === 0 || seenCursors.has(page.nextCursor)) {
            throw repeatedCursor();
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
        limit = CODEX_HISTORY_ITEM_PAGE_LIMIT;
    }
}

// Cursors only move forward past a page that was read, so an item too large to read ends the
// forward read; reading back from the turn's end recovers the items after it.
async function readTurnContents(
    client: CodexAppServerClient,
    threadId: string,
    turnId: string,
    signal: AbortSignal,
): Promise<readonly TurnContent[]> {
    const forward = await readItems(client, { threadId, turnId, sortDirection: "asc" }, new Set(), signal);
    const contents = forward.items.map((item): TurnContent => ({ kind: "item", item }));
    if (forward.complete) {
        return contents;
    }
    const read = new Set(
        forward.items.flatMap((item) => {
            const identity = itemIdentitySchema.safeParse(item);
            return identity.success ? [identity.data.id] : [];
        }),
    );
    const backward = await readItems(client, { threadId, turnId, sortDirection: "desc" }, read, signal);
    return [
        ...contents,
        { kind: "unreadable" },
        ...backward.items.toReversed().map((item): TurnContent => ({ kind: "item", item })),
    ];
}

async function fullTurnsPage(
    client: CodexAppServerClient,
    query: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
): Promise<z.infer<typeof threadTurnsPageSchema> | null> {
    try {
        return threadTurnsPageSchema.parse(
            await client.request("thread/turns/list", { ...query, itemsView: "full" }, signal),
        );
    } catch (error) {
        if (error instanceof CodexAppServerResponseTooLargeError) {
            return null;
        }
        throw error;
    }
}

async function* savedTurns(
    client: CodexAppServerClient,
    threadId: string,
    signal: AbortSignal,
): AsyncGenerator<SavedTurn> {
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
        signal.throwIfAborted();
        const query = {
            threadId,
            limit: CODEX_HISTORY_TURN_PAGE_LIMIT,
            sortDirection: "asc",
            ...(cursor === null ? {} : { cursor }),
        };
        let page = await fullTurnsPage(client, query, signal);
        if (page !== null) {
            for (const turn of page.data) {
                yield {
                    id: turn.id,
                    error: turn.error,
                    contents: turn.items.map((item): TurnContent => ({ kind: "item", item })),
                };
            }
        } else {
            // Codex returns a page's items in one message, so a page too large to read is read again
            // turn by turn; only an item that alone exceeds the limit stays unread.
            page = threadTurnsPageSchema.parse(
                await client.request("thread/turns/list", { ...query, itemsView: "notLoaded" }, signal),
            );
            for (const turn of page.data) {
                yield {
                    id: turn.id,
                    error: turn.error,
                    contents:
                        turn.id === undefined
                            ? [{ kind: "unreadable" }]
                            : await readTurnContents(client, threadId, turn.id, signal),
                };
            }
        }
        if (page.nextCursor == null) {
            return;
        }
        if (page.data.length === 0 || seenCursors.has(page.nextCursor)) {
            throw repeatedCursor();
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
    }
}

function turnIdentity(threadId: string, turnKey: string): string {
    return createHash("sha256").update(threadId).update("\0").update(turnKey).digest("hex");
}

/** Reads and projects saved items without resuming or changing the thread. */
export async function replayCodexHistory(
    client: CodexAppServerClient,
    threadId: string,
    emit: (update: CodexSessionUpdate) => Promise<void>,
    signal: AbortSignal,
): Promise<void> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    const emitItem = async (rawItem: unknown): Promise<void> => {
        const item = decodeThreadItem(rawItem);
        if (item === null) {
            return;
        }
        if (item.type === "userMessage") {
            const contents = item.content.flatMap((content) => {
                if (typeof content !== "object" || content === null) {
                    return [];
                }
                const type = Reflect.get(content, "type");
                const text = Reflect.get(content, "text");
                const url = Reflect.get(content, "url");
                if (type === "image" && typeof url === "string") {
                    return [`[@image](${url})`];
                }
                return type === "text" && typeof text === "string" ? [text] : [];
            });
            // Keep native input boundaries: joining adjacent resource links
            // would turn the first file URL into part of the next input.
            for (const text of contents) {
                const message = await resolveHistoryTextImages(text, deadline);
                for (const image of message.images) {
                    await emit({
                        content: { type: "image", data: image.data, mimeType: image.mimeType },
                        messageId: item.id,
                        sessionUpdate: "user_message_chunk",
                    });
                }
                const restoredText = message.text;
                if (restoredText.length > 0) {
                    await emit({
                        content: { text: restoredText, type: "text" },
                        messageId: item.id,
                        sessionUpdate: "user_message_chunk",
                    });
                }
            }
        } else if (item.type === "agentMessage" || item.type === "plan") {
            await emit(agentMessageUpdate(item.id, item.text, messageQuestions(item)));
        } else if (item.type === "reasoning") {
            const text = reasoningText(item);
            if (text !== null && text.length > 0) {
                await emit({
                    content: { text, type: "text" },
                    messageId: item.id,
                    sessionUpdate: "agent_thought_chunk",
                });
            }
        } else if (item.type === "contextCompaction") {
            await emit({ compactionId: item.id, sessionUpdate: "compaction_update", status: "completed" });
        } else {
            const update = toolCallUpdate(item, "snapshot");
            if (update !== null) {
                await emit({ ...update, sessionUpdate: "tool_call" });
            }
        }
    };
    let turnIndex = 0;
    for await (const turn of savedTurns(client, threadId, deadline)) {
        const turnKey = turn.id ?? turnIndex.toString();
        for (const content of turn.contents) {
            deadline.throwIfAborted();
            if (content.kind === "item") {
                await emitItem(content.item);
            } else {
                await emit({
                    sessionUpdate: "tool_call",
                    toolCallId: `history-unreadable-${turnIdentity(threadId, turnKey)}`,
                    title: "Too large to show",
                    kind: "other",
                    status: "failed",
                    content: [
                        {
                            type: "content",
                            content: { type: "text", text: "Part of this turn is too large for Morty to load." },
                        },
                    ],
                });
            }
        }
        if (turn.error != null) {
            await emit({
                sessionUpdate: "tool_call",
                toolCallId: `agent-error-${turnIdentity(threadId, turnKey)}`,
                title: "Agent error",
                kind: "other",
                status: "failed",
                rawOutput: { message: turn.error.message },
                content: [{ type: "content", content: { type: "text", text: turn.error.message } }],
            });
        }
        turnIndex += 1;
    }
}
