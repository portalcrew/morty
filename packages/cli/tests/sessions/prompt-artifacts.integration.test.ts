import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { PROMPT_IMAGE_MAX_BYTES, type PromptAttachment } from "@portalcrew/morty-client/protocol";
import { expect, test } from "vitest";
import { buildPromptContent } from "../../src/engine/acp/client/prompt-content.ts";
import { unsupportedSessionCapabilities } from "../../src/engine/acp/protocol/session-capabilities.ts";
import { resolvePromptArtifacts } from "../../src/engine/session/prompt/prompt-artifacts.ts";

function imageAttachment(bytes: Uint8Array): PromptAttachment {
    return {
        byteLength: bytes.byteLength,
        contentKey: createHash("sha256").update(bytes).digest("hex"),
        kind: "image",
        mimeType: "image/png",
        name: "large-image.png",
        uri: "attachment:///large-image.png",
    };
}

test("Given an image above the former Base64 limit, When prompt artifacts resolve, Then the original bytes are accepted", async () => {
    const bytes = new Uint8Array(3_100_000);
    const artifacts = await resolvePromptArtifacts(
        () => Promise.resolve({ bytes, path: "/tmp/morty/image-hash" }),
        [imageAttachment(bytes)],
        new AbortController().signal,
    );

    expect(artifacts.images).toHaveLength(1);
    expect(Buffer.from(artifacts.images[0]?.data ?? "", "base64").byteLength).toBe(bytes.byteLength);
});

test("Given an image above the shared prompt limit, When prompt artifacts resolve, Then it is skipped before Base64 encoding", async () => {
    const bytes = new Uint8Array(PROMPT_IMAGE_MAX_BYTES + 1);

    const result = await resolvePromptArtifacts(
        () => Promise.resolve({ bytes, path: "/tmp/morty/image-hash" }),
        [imageAttachment(bytes)],
        new AbortController().signal,
    );
    expect(result.images).toEqual([]);
    expect(result.resources).toEqual([]);
});

test("Given an unsupported attachment with invalid integrity, When resolving the prompt, Then corruption is rejected instead of downgraded", async () => {
    const bytes = new TextEncoder().encode("original PDF");
    const attachment: PromptAttachment = {
        ...imageAttachment(bytes),
        kind: "resource",
        mimeType: "application/pdf",
        name: "document.pdf",
    };
    await expect(
        resolvePromptArtifacts(
            () => Promise.resolve({ bytes: new Uint8Array(bytes.length), path: "/tmp/morty/pdf-hash.pdf" }),
            [attachment],
            new AbortController().signal,
        ),
    ).rejects.toMatchObject({ code: "artifact_integrity_failed" });
});

test("Given an SVG resource, When prompt artifacts resolve, Then the Agent receives its content-addressed file path", async () => {
    const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>');
    const path = "/tmp/morty/session-content/resource/0123456789abcdef.svg";
    const attachment: PromptAttachment = {
        byteLength: bytes.byteLength,
        contentKey: createHash("sha256").update(bytes).digest("hex"),
        kind: "resource",
        mimeType: "image/svg+xml",
        name: "diagram.svg",
        uri: "attachment:///diagram.svg",
    };

    const artifacts = await resolvePromptArtifacts(
        () => Promise.resolve({ bytes, path }),
        [attachment],
        new AbortController().signal,
    );

    expect(artifacts.images).toEqual([]);
    expect(artifacts.resources).toEqual([
        {
            mimeType: "image/svg+xml",
            name: "diagram.svg",
            type: "link",
            uri: pathToFileURL(path).href,
        },
    ]);
    expect(
        buildPromptContent(
            { images: artifacts.images, prompt: "Inspect this SVG", resources: artifacts.resources },
            unsupportedSessionCapabilities(),
        ),
    ).toContainEqual({
        mimeType: "image/svg+xml",
        name: "diagram.svg",
        type: "resource_link",
        uri: pathToFileURL(path).href,
    });
});

test("Given a PDF resource, When prompt artifacts resolve, Then the Agent receives its content-addressed file path", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\n% binary document\n");
    const path = "/tmp/morty/session-content/resource/fedcba9876543210.pdf";
    const attachment: PromptAttachment = {
        byteLength: bytes.byteLength,
        contentKey: createHash("sha256").update(bytes).digest("hex"),
        kind: "resource",
        mimeType: "application/pdf",
        name: "document.pdf",
        uri: "attachment:///document.pdf",
    };

    const artifacts = await resolvePromptArtifacts(
        () => Promise.resolve({ bytes, path }),
        [attachment],
        new AbortController().signal,
    );

    expect(artifacts.images).toEqual([]);
    expect(artifacts.resources).toEqual([
        {
            mimeType: "application/pdf",
            name: "document.pdf",
            type: "link",
            uri: pathToFileURL(path).href,
        },
    ]);
});
