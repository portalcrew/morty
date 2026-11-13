import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import * as v from "valibot";
import { expect, test } from "vitest";
import worker from "../src/worker/application.ts";

const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["node:*", "cloudflare:*"],
    loader: { ".txt": "text", ".sql": "text" },
});
const output = bundle.outputFiles[0];
if (output === undefined) {
    throw new Error("Missing Worker bundle");
}
const workerScript = output.text;

function createRuntime(options: { readonly appOrigin?: string } = {}) {
    return new Miniflare(
        convertV4MiniflareOptions({
            modules: true,
            script: workerScript,
            compatibilityDate: "2026-09-07",
            compatibilityFlags: ["nodejs_compat"],
            ...(options.appOrigin === undefined ? {} : { bindings: { APP_ORIGIN: options.appOrigin } }),
        }),
    );
}

test("Given the setup document, When users fetch it from configured and standalone origins, Then the rendered command is safe and current", async () => {
    const response = await worker.fetch(new Request("https://preview.example/doc/setup.md?token=ticket"), {
        APP_ORIGIN: "https://chat.example",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=300");
    const document = await response.text();
    expect(document).toMatch(/^# Set up Morty\n/);
    expect(document).not.toContain("change-policy");
    expect(document).toContain("Chat origin: https://chat.example");
    expect(document).toContain("morty setup --base-url https://chat.example");
    expect(document).toContain("morty revoke-all-access");
    expect(document).not.toContain("/setup.mjs");
    expect(document).not.toContain("/setup-help/");
    expect(document).toContain("local\napplication data directory");
    expect(document).not.toContain("Documents");
    expect(document).not.toContain("DOCUMENT_DIR");
    expect(document).not.toContain("MORTY_STATE_DIRECTORY");
    expect(document).not.toContain("```powershell");
    expect(document).not.toContain("```sh");
    expect(document).not.toMatch(/\{\{.*\}\}|preview\.example|paradev\.biz|paraflow\.biz|token=ticket/);
    expect(document).toContain("--harness <own-harness-id>");
    expect(document).toContain("never substitute another harness");

    for (const origin of ["https://custom.example", "http://localhost:5173"]) {
        const response = await worker.fetch(
            new Request(`${origin}/doc/setup.md`, { headers: { "X-Forwarded-Host": "other.example" } }),
            {},
        );
        expect(response.status).toBe(200);
        expect(await response.text()).toContain(`Chat origin: ${origin}`);
    }

    for (const appOrigin of [
        "https://chat.example/path",
        "https://user:pass@chat.example",
        "javascript:alert(1)",
        "",
        42,
    ]) {
        const response = await worker.fetch(new Request("https://preview.example/doc/setup.md"), {
            APP_ORIGIN: appOrigin,
        });
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
            error: { code: "INVALID_INSTRUCTION_ORIGIN", message: "The instruction origin is invalid." },
        });
    }
});

test("Given rendered setup instructions at the edge, When users fetch different query strings, Then the CDN shares a query-free document cache", async () => {
    const runtime = createRuntime({ appOrigin: "https://chat.example" });
    try {
        const first = await runtime.dispatchFetch("https://preview.example/doc/setup.md?token=first");
        expect(first.status).toBe(200);
        expect(first.headers.get("X-Instruction-Cache")).toBe("MISS");
        const document = await first.text();

        const second = await runtime.dispatchFetch("https://preview.example/doc/setup.md?token=second");
        expect(second.headers.get("X-Instruction-Cache")).toBe("HIT");
        expect(await second.text()).toBe(document);
        expect(document).toContain("Chat origin: https://chat.example");
        expect(document).not.toMatch(/token=first|token=second/);

        const otherHost = await runtime.dispatchFetch("https://other.example/doc/setup.md?token=third");
        expect(otherHost.headers.get("X-Instruction-Cache")).toBe("MISS");
    } finally {
        await runtime.dispose();
    }
});

test("Given setup replaced this computer's Morty Computer, When an agent follows the setup document, Then it tells the user that earlier links stopped working", async () => {
    const response = await worker.fetch(new Request("https://preview.example/doc/setup.md"), {
        APP_ORIGIN: "https://chat.example",
    });
    const document = (await response.text()).replaceAll("\n", " ");

    expect(document).toContain('When `computer` is `"replaced"`');
    expect(document).toContain("links and browsers from this computer's earlier Morty setup stopped working");
});

test("Given a missing saved connection, When an agent follows setup instructions, Then it asks before replacing and reports revoked or uncertain access even on failure", async () => {
    const response = await worker.fetch(new Request("https://preview.example/doc/setup.md"), {
        APP_ORIGIN: "https://chat.example",
    });
    const document = (await response.text()).replaceAll("\n", " ");

    expect(document).toContain("COMPUTER_REPLACEMENT_REQUIRED");
    expect(document).toContain("Merely asking to run setup or reconnect is not approval.");
    expect(document).toContain("--replace-computer <computerId>");
    expect(document).toContain("Do not retry with this option automatically");
    expect(document).toContain("Do not wait for ready to report this access change.");
    expect(document).toContain("error.replacementAccess.message");
    expect(document).toContain("never say the old links are still valid");
});

test("Given the setup document, When an agent follows it, Then it neither passes nor asks the user for a session ID", async () => {
    const response = await worker.fetch(new Request("https://preview.example/doc/setup.md"), {
        APP_ORIGIN: "https://chat.example",
    });
    const document = await response.text();
    const command = document.match(/^morty (setup .+)$/mu)?.[1];

    expect(command).toContain("--harness <own-harness-id>");
    expect(command).not.toContain("--session-id");
    expect(document.replaceAll("\n", " ")).not.toMatch(/ask the user for (it|the session)/u);
});

test("Given an AI agent receives a continue link, When it fetches the agent guide and API schemas, Then each names the serving origin and the documented API", async () => {
    const bindings = { APP_ORIGIN: "https://chat.example" };
    const guide = await worker.fetch(new Request("https://preview.example/doc/agent-api.md?token=ticket"), bindings);
    expect(guide.status).toBe(200);
    expect(guide.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const text = await guide.text();
    expect(text).toMatch(/^# Morty agent API\n/);
    expect(text).toContain("Morty origin: https://chat.example");
    expect(text).toContain("https://chat.example/doc/agent-api/openapi.json");
    expect(text).toContain("https://chat.example/doc/agent-api/asyncapi.json");
    expect(text).toContain("/morty/api/v1/identity/transfers/redeem");
    expect(text).not.toMatch(/\{\{.*\}\}|preview\.example|token=ticket/);

    const openApiResponse = await worker.fetch(
        new Request("https://preview.example/doc/agent-api/openapi.json"),
        bindings,
    );
    expect(openApiResponse.status).toBe(200);
    expect(openApiResponse.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const openApi = v.parse(
        v.object({
            openapi: v.literal("3.1.0"),
            servers: v.tuple([v.object({ url: v.literal("https://chat.example") })]),
            paths: v.record(v.string(), v.record(v.string(), v.object({ operationId: v.string() }))),
        }),
        await openApiResponse.json(),
    );
    const operations = Object.values(openApi.paths).flatMap((methods) =>
        Object.values(methods).map((operation) => operation.operationId),
    );
    expect(operations).toEqual(
        expect.arrayContaining(["redeemTransfer", "openSession", "readActiveTurn", "submitTurn", "listSessionEvents"]),
    );
    expect(JSON.stringify(openApi)).not.toContain("preview.example");

    const asyncApiResponse = await worker.fetch(
        new Request("https://preview.example/doc/agent-api/asyncapi.json"),
        bindings,
    );
    expect(asyncApiResponse.status).toBe(200);
    const asyncApi = v.parse(
        v.object({
            asyncapi: v.literal("3.0.0"),
            servers: v.object({ morty: v.object({ host: v.literal("chat.example"), protocol: v.literal("wss") }) }),
            channels: v.object({
                transport: v.object({ messages: v.record(v.string(), v.object({ name: v.string() })) }),
            }),
        }),
        await asyncApiResponse.json(),
    );
    expect(Object.values(asyncApi.channels.transport.messages).map((message) => message.name)).toEqual(
        expect.arrayContaining(["http.request", "http.response", "http.error", "session.events.subscribe"]),
    );
});

test("Given agent documents at the edge, When agents fetch them with different query strings, Then the CDN shares one rendered copy per origin", async () => {
    const runtime = createRuntime({ appOrigin: "https://chat.example" });
    try {
        for (const path of [
            "/doc/setup.md",
            "/doc/agent-api.md",
            "/doc/agent-api/openapi.json",
            "/doc/agent-api/asyncapi.json",
        ]) {
            const first = await runtime.dispatchFetch(`https://preview.example${path}?token=first`);
            expect(first.status).toBe(200);
            expect(first.headers.get("X-Instruction-Cache")).toBe("MISS");
            const body = await first.text();
            const second = await runtime.dispatchFetch(`https://preview.example${path}?token=second`);
            expect(second.headers.get("X-Instruction-Cache")).toBe("HIT");
            expect(await second.text()).toBe(body);
        }
    } finally {
        await runtime.dispose();
    }
});

test("Given the generated agent API descriptions, When an agent follows every schema reference, Then each resolves inside its document", async () => {
    for (const path of ["/doc/agent-api/openapi.json", "/doc/agent-api/asyncapi.json"]) {
        const response = await worker.fetch(new Request(`https://preview.example${path}`), {
            APP_ORIGIN: "https://chat.example",
        });
        const document: unknown = await response.json();
        const references: string[] = [];
        const collect = (value: unknown): void => {
            if (Array.isArray(value)) {
                value.forEach(collect);
            } else if (typeof value === "object" && value !== null) {
                for (const [key, entry] of Object.entries(value)) {
                    if (key === "$ref" && typeof entry === "string") {
                        references.push(entry);
                    } else {
                        collect(entry);
                    }
                }
            }
        };
        collect(document);
        expect(references.length, path).toBeGreaterThan(0);
        for (const reference of references) {
            expect(reference, path).toMatch(/^#\//u);
            const target = reference
                .slice(2)
                .split("/")
                .reduce<unknown>(
                    (node, segment) =>
                        typeof node === "object" && node !== null
                            ? Object.entries(node).find(([key]) => key === segment.replaceAll("~1", "/"))?.[1]
                            : undefined,
                    document,
                );
            expect(target, `${path} ${reference}`).toBeDefined();
        }
    }
});
