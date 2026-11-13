import {
    computerEncryptionAccessCodec,
    importE2EPublicKey,
    MortyError,
    MortyPageRequest,
    MortyProtocolError,
    MortyValidationError,
} from "@morty-build/client";
import * as v from "valibot";
import { WorkerApiTransport } from "./api/worker-api-transport.ts";
import { BotChatApi } from "./chat/bot-chat-api.ts";

export async function runSharedComputer(options: {
    readonly link: string;
    readonly redemptionKey: string;
    readonly conversationKey: string;
    readonly turnId: string;
    readonly prompt: string;
    readonly harness: string;
    readonly directory: string;
    readonly signal: AbortSignal;
}): Promise<{ readonly answer: string }> {
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(120_000)]);
    signal.throwIfAborted();
    let link: URL;
    try {
        link = new URL(options.link);
    } catch {
        throw new MortyValidationError("Invalid continue link");
    }
    if (
        (link.protocol !== "https:" &&
            !(link.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(link.hostname))) ||
        link.username ||
        link.password ||
        link.pathname !== "/continue"
    ) {
        throw new MortyValidationError("Invalid continue link");
    }
    const fragment = new URLSearchParams(link.hash.slice(1));
    const code = fragment.get("code");
    const encoded = fragment.get("e2e");
    if (code === null || encoded === null || encoded.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
        throw new MortyValidationError("The continue link has no encrypted Computer access");
    }
    let access: ReturnType<typeof computerEncryptionAccessCodec.decode>;
    try {
        access = computerEncryptionAccessCodec.decode(
            new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64url")),
        );
        await importE2EPublicKey(access.computerE2EPublicKey);
    } catch {
        signal.throwIfAborted();
        throw new MortyValidationError("The continue link has invalid encrypted Computer access");
    }
    const response = await fetch(new URL("/morty/api/v1/identity/transfers/redeem", link.origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, redemptionKey: options.redemptionKey, device: "Remote Agent" }),
        signal,
        redirect: "error",
    });
    let value: unknown;
    try {
        value = await response.json();
    } catch (cause) {
        signal.throwIfAborted();
        throw new MortyProtocolError("The service returned an invalid redemption response", { cause });
    }
    if (!response.ok) {
        const failure = v.safeParse(
            v.object({ error: v.object({ code: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,128}$/u)) }) }),
            value,
        );
        if (!failure.success) {
            throw new MortyProtocolError("The service returned an invalid redemption response");
        }
        throw new MortyError(failure.output.error.code, "Computer access could not be redeemed");
    }
    const parsed = v.safeParse(v.object({ computerId: v.string(), computerToken: v.string() }), value);
    if (!parsed.success) {
        throw new MortyProtocolError("The service returned an invalid redemption response");
    }
    const identity = parsed.output;
    if (identity.computerId !== access.computerId) {
        throw new MortyProtocolError("Encrypted access does not match the Computer");
    }
    const transport = new WorkerApiTransport(link.origin, (computerId) =>
        computerId === access.computerId ? access : null,
    );
    const api = new BotChatApi({
        sessionTransport: () => transport.computerTransport(identity.computerId),
        encryptionAccess: () => access,
        origin: link.origin,
        computerId: identity.computerId,
        fetchRequest: transport.fetch,
        getToken: async (signal) => {
            signal.throwIfAborted();
            return identity.computerToken;
        },
        waitForChange: transport.waitForChange,
    });
    try {
        const handoffHarness = link.searchParams.get("harness");
        const handoffSession = link.searchParams.get("sessionId");
        if ((handoffHarness === null) !== (handoffSession === null)) {
            throw new MortyValidationError("Incomplete session handoff");
        }
        const openSession = async () => {
            if (handoffHarness !== null && handoffSession !== null) {
                const opened = await api.continueNativeSession(handoffHarness, handoffSession, signal);
                const target = opened.result.target;
                return { target, client: await api.connectSession(target, signal) };
            }
            const created = await api.createConversation(
                options.conversationKey,
                {
                    harness: options.harness,
                    workspaceRef: options.directory,
                    workspaceLabel: options.directory,
                    configurations: [],
                },
                signal,
            );
            return { target: created.target, client: await api.connectSession(created.target, signal, created) };
        };
        const { target, client } = await openSession();
        try {
            const finished = Promise.withResolvers<void>();
            const subscription = await client.events.subscribeLive(
                target,
                {
                    reconcile: async () => undefined,
                    receive: async (events) => {
                        for (const event of events) {
                            if (
                                event.type === "lifecycle-metadata" &&
                                "commandId" in event.payload &&
                                event.payload.commandId === options.turnId &&
                                ["prompt.completed", "prompt.failed", "prompt.failed-before-start"].includes(
                                    event.payload.kind,
                                )
                            ) {
                                finished.resolve();
                            }
                        }
                        return true;
                    },
                },
                signal,
            );
            // The stream can fail while submission or history retrieval is still in progress.
            void subscription.completed.catch(() => undefined);
            try {
                await client.turns.submit(
                    target,
                    { content: options.prompt, attachments: [], idempotencyKey: options.turnId },
                    signal,
                );
                const readAnswer = async (): Promise<string | null> => {
                    let cursor = "";
                    const cursors = new Set<string>();
                    const pages = [];
                    do {
                        if (cursors.has(cursor) || cursors.size >= 100) {
                            throw new MortyProtocolError("Session history is too large or invalid");
                        }
                        cursors.add(cursor);
                        const page = await client.events.list(target, new MortyPageRequest(100, cursor), signal);
                        pages.unshift(...page.events);
                        cursor = page.nextCursor ?? "";
                    } while (cursor !== "");
                    let collecting = false;
                    let answer = "";
                    for (const event of pages) {
                        if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.started") {
                            collecting = event.payload.commandId === options.turnId;
                            if (collecting) {
                                answer = "";
                            }
                        }
                        if (
                            event.type === "lifecycle-metadata" &&
                            "commandId" in event.payload &&
                            event.payload.commandId === options.turnId
                        ) {
                            if (
                                event.payload.kind === "prompt.failed" ||
                                event.payload.kind === "prompt.failed-before-start"
                            ) {
                                throw new MortyError(event.payload.code, "Agent turn failed", { cause: event.payload });
                            }
                            if (event.payload.kind === "prompt.completed" && collecting) {
                                if (
                                    event.payload.stopReason === "cancelled" ||
                                    event.payload.stopReason === "steered"
                                ) {
                                    throw new MortyError("turn_not_completed", "Agent turn did not complete normally");
                                }
                                return answer;
                            }
                        }
                        if (
                            collecting &&
                            event.type === "acp" &&
                            event.payload.sessionUpdate === "agent_message_chunk" &&
                            event.payload.content.type === "text"
                        ) {
                            answer += event.payload.content.text;
                        }
                    }
                    return null;
                };
                let answer = await readAnswer();
                if (answer === null) {
                    await Promise.race([finished.promise, subscription.completed]);
                    signal.throwIfAborted();
                    answer = await readAnswer();
                }
                if (answer === null) {
                    throw new MortyError("turn_result_missing", "Agent turn ended without a recorded result");
                }
                return { answer };
            } finally {
                subscription.close();
            }
        } finally {
            client.close();
        }
    } finally {
        api.close();
        transport.dispose();
    }
}
