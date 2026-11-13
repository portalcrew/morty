import {
    decodeContentChunkFrame,
    decodeMessageKind,
    decodeSessionEventEnvelope,
    decodeSessionHistoryPageLoaded,
    encodeFileReadCommand,
    encodeSessionHistoryPageLoad,
    encodeSessionPermissionRespondCommand,
    encodeSessionPromptCommand,
    type SessionEvent,
    type SessionLiveEvent,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect } from "vitest";
import type { RealDaemonPeer } from "./real-daemon.ts";

function imageReferences(events: readonly (SessionEvent | SessionLiveEvent)[]): readonly string[] {
    return events.flatMap((event) => {
        if (
            event.type !== "acp" ||
            (event.payload.sessionUpdate !== "tool_call" && event.payload.sessionUpdate !== "tool_call_update")
        ) {
            return [];
        }
        return (event.payload.content ?? []).flatMap((item) => {
            if (item.type !== "content") {
                return [];
            }
            switch (item.content.type) {
                case "external_image":
                    return [`morty-content:image:${item.content.imageKey}`];
                case "image":
                    return item.content.uri ? [item.content.uri] : [];
                default:
                    return [];
            }
        });
    });
}

/** Observe live delivery, restored native history, reverse reads and a subsequent prompt at the public daemon port. */
export async function verifyImageDelivery(
    peer: RealDaemonPeer,
    input: {
        readonly harness: string;
        readonly image: Uint8Array;
        readonly reference: string;
        readonly prompt: string;
    },
): Promise<void> {
    // Whole-value checks miss JSON fragments that were truncated before externalization.
    const encodedPrefix = Buffer.from(input.image).toString("base64").slice(0, 512);
    const sendPrompt = (commandId: string, prompt: string): void =>
        peer.send(
            encodeSessionPromptCommand({
                commandId,
                requestId: commandId,
                disposition: SessionPromptDisposition.Append,
                attachments: [],
                kind: "session.prompt",
                prompt,
                target: peer.target,
            }),
        );
    const finish = async (): Promise<readonly SessionLiveEvent[]> => {
        const events: SessionLiveEvent[] = [];
        for (;;) {
            const message = await peer.nextMessage();
            expect(message).not.toContain(encodedPrefix);
            const kind = decodeMessageKind(message);
            if (kind === "session.operation.failed") {
                throw new Error(message);
            }
            if (kind !== "session.event.v2") {
                continue;
            }
            const batch = decodeSessionEventEnvelope(message).events;
            events.push(...batch);
            for (const event of batch) {
                if (
                    event.type === "lifecycle-metadata" &&
                    (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start")
                ) {
                    throw new Error(JSON.stringify(event));
                }
                if (event.type === "lifecycle-metadata" && event.payload.kind === "session.permission.requested") {
                    const option = event.payload.event.options.find((entry) => entry.kind === "allow_once");
                    if (option === undefined) {
                        throw new Error("No one-time image read permission");
                    }
                    peer.send(
                        encodeSessionPermissionRespondCommand({
                            kind: "session.permission.respond",
                            requestId: crypto.randomUUID(),
                            interactionId: event.payload.event.interactionId,
                            target: peer.target,
                            optionId: option.optionId,
                            outcome: "selected",
                        }),
                    );
                }
            }
            if (
                batch.some((event) => event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed")
            ) {
                return events;
            }
        }
    };
    sendPrompt("image-turn", input.prompt);
    expect(imageReferences(await finish())).toContain(input.reference);
    peer.send(
        encodeSessionHistoryPageLoad({
            cursor: null,
            eventLimit: 50,
            kind: "session.live-history.v2.page.load",
            requestId: "image-history",
            target: peer.target,
        }),
    );
    for (;;) {
        const message = await peer.nextMessage();
        expect(message).not.toContain(encodedPrefix);
        const kind = decodeMessageKind(message);
        if (kind === "session.operation.failed") {
            throw new Error(message);
        }
        if (kind === "session.live-history.v2.page.loaded") {
            expect(imageReferences(decodeSessionHistoryPageLoaded(message).events.events.events)).toContain(
                input.reference,
            );
            break;
        }
    }
    peer.send(
        encodeFileReadCommand({
            kind: "file.read",
            maxBytes: 2_000_000,
            path: input.reference,
            requestId: "image-download",
            target: peer.target,
        }),
    );
    const chunks: Buffer[] = [];
    for (;;) {
        const message = await peer.nextFrame();
        if (typeof message !== "string") {
            chunks.push(Buffer.from(decodeContentChunkFrame(message).bytes));
            continue;
        }
        const kind = decodeMessageKind(message);
        if (kind === "file.failed") {
            throw new Error(message);
        }
        if (kind === "file.end") {
            break;
        }
    }
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(input.image));
    sendPrompt("continue-turn", "Continue with a short reply, without using tools");
    await finish();
}
