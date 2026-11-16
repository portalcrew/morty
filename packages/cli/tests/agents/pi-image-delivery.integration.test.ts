import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
    decodeContentChunkFrame,
    decodeFileBeginEvent,
    decodeMessageKind,
    encodeFileReadCommand,
} from "@portalcrew/morty-client/protocol";
import { expect, test } from "vitest";
import { PiAgentSpecification } from "../../src/engine/agent/specification/vendors/pi-agent.ts";
import { imageFixture } from "../support/agents/image-fixture.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { prepareNewRealSession, withRealDaemon } from "../support/agents/real-daemon.ts";
import { verifyImageDelivery } from "../support/agents/verify-image-delivery.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

for (const side of [128, 500]) {
    test(`Given real Pi reads a ${side}px image, When its reply streams and native history reopens, Then clients retrieve identical bytes without base64 fragments and can continue chatting`, async ({
        signal,
    }) => {
        const prompt = "Use the read tool to inspect picture.png, then reply";
        await using provider = await FakeOpenAiProvider.start("gpt-4.1", "IMAGE_REPLY", {
            readPath: "picture.png",
            toolPrompt: prompt,
        });
        await using agent = await PiFixture.create(provider);
        await withRealDaemon(signal, new PiAgentSpecification(), agent.environment, async (peer) => {
            const image = imageFixture(side);
            await writeFile(join(peer.workspace, "picture.png"), image);
            await verifyImageDelivery(peer, {
                harness: "pi",
                image,
                reference: `morty-content:image:${createHash("sha256").update(image).digest("hex")}`,
                prompt,
            });
        });
    });
}

test("Given real Pi creates a session containing an SVG file, When a remote client reads the image, Then the daemon returns SVG media type and the original bytes", async ({
    signal,
}) => {
    await using provider = await FakeOpenAiProvider.start("gpt-4.1", "READY");
    await using agent = await PiFixture.create(provider);
    await withRealDaemon(signal, new PiAgentSpecification(), agent.environment, async (peer) => {
        const svg =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="orange"/></svg>';
        await writeFile(join(peer.workspace, "picture.svg"), svg);
        const sessionTarget = await prepareNewRealSession(peer, "pi");
        peer.send(
            encodeFileReadCommand({
                kind: "file.read",
                maxBytes: 4096,
                path: "picture.svg",
                requestId: "read-svg",
                target: sessionTarget,
            }),
        );
        const chunks: Buffer[] = [];
        let mediaType = "";
        for (;;) {
            const message = await peer.nextFrame();
            if (typeof message !== "string") {
                chunks.push(Buffer.from(decodeContentChunkFrame(message).bytes));
                continue;
            }
            const kind = decodeMessageKind(message);
            if (kind === "file.begin") {
                mediaType = decodeFileBeginEvent(message).mediaType;
            } else if (kind === "file.end") {
                break;
            } else if (kind === "session.operation.failed") {
                throw new Error(message);
            }
        }
        expect(mediaType).toBe("image/svg+xml");
        expect(Buffer.concat(chunks).toString("utf8")).toBe(svg);
    });
});
