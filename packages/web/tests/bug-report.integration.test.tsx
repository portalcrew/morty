import { createServer } from "node:http";
import { close as closeSentry, flush } from "@sentry/react";
import { getAllByRole, getByLabelText, getByRole, queryByRole } from "@testing-library/dom";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { WorkerApiTransport } from "../src/services/api/worker-api-transport.ts";
import { initializeBrowserMonitoring } from "../src/services/diagnostics/sentry-monitoring.ts";
import { createMortyApplication } from "../src/view-models/morty-application.ts";
import { App } from "../src/views/application/app.tsx";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

/**
 * A real transport pointed at an unreachable origin and never opened: every
 * operation fails on its own, so measurements and requests degrade instead of
 * reaching the network.
 */
function noopTransport(): WorkerApiTransport {
    return new WorkerApiTransport("http://127.0.0.1:1");
}

const observers = new Set<MutationObserver>();

test("Given a browser error contains private data, When the user submits two reports, Then the error preserves its stack and both reports associate with that error without leaking automatic private data", async () => {
    const inbox = await createReportInbox();
    try {
        const app = await createTestApp({ connectAgent: true });
        await app.queryElementByTestId(dataTestId.messageComposer);
        const error = Object.assign(new Error("PRIVATE_CHAT_CONTENT token=PRIVATE_ACCESS_TOKEN"), {
            code: "ACCEPTANCE_ERROR",
            requestId: "12345678-1234-4234-8234-123456789012",
        });
        error.stack =
            "Error: PRIVATE_CHAT_CONTENT\n    at renderChat (https://morty.example/assets/app.js?token=PRIVATE_ACCESS_TOKEN:42:7)";
        globalThis.onerror?.(error.message, "https://morty.example/assets/app.js", 42, 7, error);
        await flush(2000);
        const errorEnvelope = inbox.envelopes.find((envelope) => envelope.includes('"type":"event"')) ?? "";
        expect(errorEnvelope).not.toContain("PRIVATE_CHAT_CONTENT");
        expect(errorEnvelope).not.toContain("PRIVATE_ACCESS_TOKEN");
        const event = JSON.parse(errorEnvelope.split("\n")[2] ?? "null");
        expect(event.tags).toMatchObject({
            component: "web",
            errorCode: "ACCEPTANCE_ERROR",
            requestId: error.requestId,
        });
        expect(event.contexts.morty.diagnostics.entries.length).toBeGreaterThan(0);
        expect(event.exception.values[0].stacktrace.frames).toContainEqual(
            expect.objectContaining({
                filename: "https://morty.example/assets/app.js",
                lineno: 42,
                colno: 7,
            }),
        );
        for (const description of ["First report", "Second report"]) {
            await app.user.click(getByRole(document.body, "button", { name: "Report a bug" }));
            const dialog = getByRole(document.body, "dialog", { name: "Report a bug" });
            await app.user.type(getByRole(dialog, "textbox", { name: "What went wrong?" }), description);
            await app.user.click(getByRole(dialog, "button", { name: "Send report" }));
            await visibleMessage(dialog, "status", "Report sent");
            const envelope = inbox.envelopes.at(-1) ?? "";
            const report = JSON.parse(envelope.trim().split("\n").at(-1) ?? "null");
            const feedback = JSON.parse(envelope.split("\n")[2] ?? "null");
            expect(report.relatedEventId).toBe(event.event_id);
            expect(feedback.contexts.feedback.associated_event_id).toBe(event.event_id);
            expect(report.release).toBe("morty@test-release");
            expect(envelope).not.toContain("PRIVATE_CHAT_CONTENT");
            expect(envelope).not.toContain("PRIVATE_ACCESS_TOKEN");
            await app.user.click(getByRole(dialog, "button", { name: "Close dialog" }));
        }
    } finally {
        await inbox.close();
    }
});

test("Given an Agent with a known CLI version and private model metadata, When reports are sent from the draft and a configured conversation, Then they contain version and model evidence without chat content or private metadata", {
    timeout: 60_000,
}, async () => {
    const inbox = await createReportInbox();
    try {
        let app = await createTestApp({
            connectAgent: true,
            agent: { harness: "diagnostics-test", label: "Settings Agent" },
        });
        await app.queryElementByTestId(
            dataTestId.agentConfiguration,
            (element) => element.textContent?.includes("GPT-6-Sol") === true,
        );
        await app.user.click(getByRole(document.body, "button", { name: "Configure agent" }));
        await app.user.click(getByRole(document.body, "combobox", { name: "Model" }));
        await app.user.click(getByRole(document.body, "option", { name: "GPT-6.1-Sol" }));
        await app.user.click(getByRole(document.body, "button", { name: "Close Agent configuration" }));
        const report = async () => {
            const previousReports = inbox.envelopes.length;
            await app.user.click(getByRole(document.body, "button", { name: "Report a bug" }));
            const dialog = getByRole(document.body, "dialog", { name: "Report a bug" });
            await app.user.type(getByRole(dialog, "textbox", { name: "What went wrong?" }), "Model menu differs");
            await app.user.click(getByRole(dialog, "button", { name: "Send report" }));
            await visibleMessage(dialog, "status", "Report sent");
            expect(inbox.envelopes).toHaveLength(previousReports + 1);
            const envelope = inbox.envelopes.at(-1) ?? "";
            for (const secret of [
                "PRIVATE_MODEL_DESCRIPTION",
                "PRIVATE_MODEL_LABEL",
                "PRIVATE_DEPLOYMENT_NAME",
                "PRIVATE_CHAT_CONTENT",
            ]) {
                expect(envelope).not.toContain(secret);
            }
            return JSON.parse(envelope.trim().split("\n").at(-1) ?? "null");
        };
        const draft = await report();
        expect(draft.chat).toMatchObject({
            kind: "available",
            view: "draft",
            computerOnline: true,
            agent: { version: "0.153.4" },
            catalog: {
                source: "agent-settings",
                models: [{ selected: "gpt-6-sol", values: ["gpt-6-sol", "gpt-6.1-sol", "private-model-1"], count: 3 }],
            },
            visibleModels: [{ selected: "gpt-6.1-sol", count: 3 }],
        });
        expect(draft.chat.catalog.observedAt).toBe("2026-10-13T08:00:00.000Z");
        await app.user.click(getByRole(document.body, "button", { name: "Close dialog" }));
        await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "PRIVATE_CHAT_CONTENT");
        await app.waitForView(() =>
            expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
                "Settings Agent: PRIVATE_CHAT_CONTENT",
            ),
        );
        await app.waitForView(() => {
            expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
            expect(app.elementByTestId(dataTestId.messageComposer).hasAttribute("disabled")).toBe(false);
        });
        app = await app.reload();
        await app.queryElementByTestId(
            dataTestId.agentConfiguration,
            (element) => element.textContent?.includes("GPT-6.1-Sol") === true,
        );
        const session = await report();
        const feedback = JSON.parse((inbox.envelopes.at(-1) ?? "").split("\n")[2] ?? "null");
        expect(feedback.tags).toMatchObject({ component: "web", reportId: session.id });
        expect(session.relatedEventId).toBeNull();
        expect(session.sessionId).not.toBe("");
        expect(session.chat).toMatchObject({
            kind: "available",
            view: "session",
            agent: { version: "0.153.4" },
            catalog: { source: "session-ready" },
            visibleModels: [{ selected: "gpt-6.1-sol", count: 3 }],
        });
    } finally {
        await inbox.close();
    }
});
const pngBytes = Uint8Array.from(
    atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOuoAAAAASUVORK5CYII="),
    (char) => char.charCodeAt(0),
);
beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T08:00:00Z"));
});
afterEach(() => {
    for (const observer of observers) {
        observer.disconnect();
    }
    observers.clear();
    cleanup();
    vi.useRealTimers();
});

test("Given the report dialog is open, When a user pastes and selects images and removes one, Then Sentry receives only the remaining image with the description and diagnostics", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T08:00:00Z"));
    const inbox = await createReportInbox();
    try {
        render(
            <App
                bugReportDialog={
                    createMortyApplication({ origin: window.location.origin, transport: noopTransport() })
                        .bugReportDialog
                }
                state={{ kind: "failed", retry: () => window.location.reload(), retrying: false }}
            />,
        );
        const user = userEvent.setup();
        await user.click(getByRole(document.body, "button", { name: "Report a bug" }));
        const description = getByRole(document.body, "textbox", { name: "What went wrong?" });
        await user.type(description, "The layout is broken");
        const clipboard = new DataTransfer();
        clipboard.items.add(new File([pngBytes], "pasted.png", { type: "image/png" }));
        await user.paste(clipboard);
        expect(getByRole(document.body, "img", { name: "pasted.png" })).toBeDefined();
        await user.upload(
            getByLabelText(document.body, "Attach images"),
            new File([pngBytes], "selected.png", { type: "image/png" }),
        );
        expect(getByRole(document.body, "img", { name: "selected.png" })).toBeDefined();
        await user.click(getByRole(document.body, "button", { name: "Remove selected.png" }));
        expect(queryByRole(document.body, "img", { name: "selected.png" })).toBeNull();
        expect(inbox.envelopes).toHaveLength(0);
        await user.click(getByRole(document.body, "button", { name: "Send report" }));
        await visibleMessage(document.body, "status", "Report sent");
        expect(inbox.envelopes).toHaveLength(1);
        const envelope = inbox.envelopes[0] ?? "";
        expect(envelope).toContain('"description":"The layout is broken"');
        expect(envelope).toContain('"filename":"diagnostics.json"');
        expect(envelope).toContain('"filename":"image-1.png"');
        expect(envelope).toContain('"content_type":"image/png"');
        expect(envelope).not.toContain('"filename":"image-2.png"');
        expect(inbox.bodies[0]?.includes(Buffer.from(pngBytes))).toBe(true);
    } finally {
        await inbox.close();
        vi.useRealTimers();
    }
});

test.each([
    { name: "an unsupported file", type: "image/svg+xml", size: 20, count: 1, error: "Only PNG, JPEG, GIF, and WebP" },
    { name: "an oversized image", type: "image/png", size: 2_500_001, count: 1, error: "between 1 byte and 2.5 MB" },
    { name: "an empty image", type: "image/png", size: 0, count: 1, error: "between 1 byte and 2.5 MB" },
    { name: "too many images", type: "image/png", size: 20, count: 4, error: "up to 3 images" },
])(
    "Given the report dialog is open, When the user pastes $name, Then an actionable error appears without uploading it",
    async ({ type, size, count, error }) => {
        const inbox = await createReportInbox();
        try {
            render(
                <App
                    bugReportDialog={
                        createMortyApplication({ origin: window.location.origin, transport: noopTransport() })
                            .bugReportDialog
                    }
                    state={{ kind: "failed", retry: () => window.location.reload(), retrying: false }}
                />,
            );
            const user = userEvent.setup();
            await user.click(getByRole(document.body, "button", { name: "Report a bug" }));
            await user.click(getByRole(document.body, "textbox", { name: "What went wrong?" }));
            await user.paste("The layout is broken");
            const clipboard = new DataTransfer();
            for (let index = 0; index < count; index += 1) {
                clipboard.items.add(new File([new Uint8Array(size)], `invalid-${index}.png`, { type }));
            }
            await user.paste(clipboard);
            const dialog = getByRole(document.body, "dialog");
            expect(getByRole(dialog, "alert").textContent).toContain(error);
            expect(queryByRole(dialog, "list", { name: "Attached images" })).toBeNull();
            expect(inbox.envelopes).toHaveLength(0);
            await user.click(getByRole(dialog, "button", { name: "Send report" }));
            await visibleMessage(dialog, "status", "Report sent");
            expect(inbox.envelopes[0]).toContain('"description":"The layout is broken"');
            expect(inbox.envelopes[0]).not.toContain('"content_type":"image/');
        } finally {
            await inbox.close();
        }
    },
);

test("Given a file claims to be a PNG, When its contents do not match and the user submits it, Then the report is rejected locally and can be sent after removing the image", async () => {
    const inbox = await createReportInbox();
    try {
        render(
            <App
                bugReportDialog={
                    createMortyApplication({ origin: window.location.origin, transport: noopTransport() })
                        .bugReportDialog
                }
                state={{ kind: "failed", retry: () => window.location.reload(), retrying: false }}
            />,
        );
        const user = userEvent.setup();
        await user.click(getByRole(document.body, "button", { name: "Report a bug" }));
        await user.type(getByRole(document.body, "textbox", { name: "What went wrong?" }), "The layout is broken");
        await user.upload(
            getByLabelText(document.body, "Attach images"),
            new File(["not an image"], "invalid.png", { type: "image/png" }),
        );
        await user.click(getByRole(document.body, "button", { name: "Send report" }));
        const dialog = getByRole(document.body, "dialog");
        await visibleMessage(dialog, "alert", "does not match");
        expect(inbox.envelopes).toHaveLength(0);
        await user.click(getByRole(dialog, "button", { name: "Remove invalid.png" }));
        await user.click(getByRole(dialog, "button", { name: "Send report" }));
        await visibleMessage(dialog, "status", "Report sent");
        expect(inbox.envelopes).toHaveLength(1);
    } finally {
        await inbox.close();
    }
});
function visibleMessage(container: HTMLElement, role: "status" | "alert", text: string): Promise<HTMLElement> {
    return new Promise((resolve) => {
        const check = () => {
            const element = queryByRole(container, role);
            if (element?.textContent?.includes(text) === true) {
                observer.disconnect();
                observers.delete(observer);
                resolve(element);
            }
        };
        const observer = new MutationObserver(check);
        observers.add(observer);
        observer.observe(container, { childList: true, subtree: true, characterData: true });
        check();
    });
}

// Stateful Sentry peer at its HTTP ingestion boundary, with the real browser SDK.
async function createReportInbox() {
    const envelopes: string[] = [];
    const bodies: Buffer[] = [];
    let status = 200;
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks);
        // Tracing spans and release-health sessions arrive on their own schedule; the inbox records reports only.
        const itemType = JSON.parse(body.toString("utf8").split("\n")[1] || "{}").type;
        if (request.method === "POST" && status === 200 && (itemType === "event" || itemType === "feedback")) {
            bodies.push(body);
            envelopes.push(body.toString("utf8"));
        }
        response
            .writeHead(request.method === "OPTIONS" ? 200 : status, {
                "content-type": "application/json",
                "access-control-allow-origin": "*",
                "access-control-allow-methods": "POST, OPTIONS",
                "access-control-allow-headers": "content-type, sentry-trace, baggage",
            })
            .end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("The report inbox did not listen");
    }
    initializeBrowserMonitoring({
        dsn: `http://public@127.0.0.1:${address.port}/1`,
        environment: "test",
        release: "morty@test-release",
    });
    return {
        envelopes,
        bodies,
        accept: (next: number) => {
            status = next;
        },
        close: async () => {
            await closeSentry();
            await new Promise<void>((resolve, reject) => server.close((cause) => (cause ? reject(cause) : resolve())));
        },
    };
}

test("Given Morty cannot load and no daemon is connected, When a user reports a bug, Then Sentry receives the description and available diagnostics and the user sees a report number", async () => {
    const inbox = await createReportInbox();
    try {
        render(
            <App
                bugReportDialog={
                    createMortyApplication({ origin: window.location.origin, transport: noopTransport() })
                        .bugReportDialog
                }
                state={{ kind: "failed", retry: () => window.location.reload(), retrying: false }}
            />,
        );
        const user = userEvent.setup();
        await user.click(getByRole(document.body, "button", { name: "Report a bug" }));
        await user.type(
            getByRole(document.body, "textbox", { name: "What went wrong?" }),
            "The conversation never opened",
        );
        await user.click(getByRole(document.body, "button", { name: "Send report" }));
        const confirmation = await visibleMessage(document.body, "status", "Report sent");
        expect(confirmation.textContent).toContain("Report sent. Reference:");
        expect(confirmation.textContent).toContain("Daemon diagnostics were unavailable");
        expect(inbox.envelopes).toHaveLength(1);
        const envelope = inbox.envelopes[0] ?? "";
        expect(envelope).toContain('"type":"feedback"');
        expect(envelope).toContain('"filename":"diagnostics.json"');
        expect(envelope).toContain('"description":"The conversation never opened"');
        expect(envelope).toContain('"code":"NO_ACTIVE_COMPUTER"');
        const report = JSON.parse(envelope.trim().split("\n").at(-1) ?? "null");
        expect(report.network).toMatchObject({
            online: navigator.onLine,
            measurements: {
                browserMorty: { kind: "unavailable" },
                mortyComputer: { kind: "unavailable", code: "NO_ACTIVE_COMPUTER" },
            },
        });
        expect(report.network).not.toHaveProperty("vpn");
        expect(report.network).not.toHaveProperty("proxy");
        expect(getByRole(document.body, "button", { name: "Close dialog" })).toBeDefined();
    } finally {
        await inbox.close();
    }
});

test("Given Sentry rejects a report, When the user retries after it recovers, Then the description is preserved and a report can be sent", async () => {
    const inbox = await createReportInbox();
    try {
        inbox.accept(503);
        render(
            <App
                bugReportDialog={
                    createMortyApplication({ origin: window.location.origin, transport: noopTransport() })
                        .bugReportDialog
                }
                state={{ kind: "failed", retry: () => window.location.reload(), retrying: false }}
            />,
        );
        const user = userEvent.setup();
        await user.click(getByRole(document.body, "button", { name: "Report a bug" }));
        await user.type(getByRole(document.body, "textbox", { name: "What went wrong?" }), "My message disappeared");
        await user.upload(
            getByLabelText(document.body, "Attach images"),
            new File([pngBytes], "retry.png", { type: "image/png" }),
        );
        await user.click(getByRole(document.body, "button", { name: "Send report" }));
        // The application already has its startup error; the dialog owns the report error.
        const dialog = getByRole(document.body, "dialog");
        expect((await visibleMessage(dialog, "alert", "not accepted")).textContent).toContain("not accepted");
        expect(getByRole(dialog, "img", { name: "retry.png" })).toBeDefined();
        inbox.accept(200);
        await user.click(getByRole(dialog, "button", { name: "Send report" }));
        expect((await visibleMessage(dialog, "status", "Report sent")).textContent).toContain("Report sent");
        expect(inbox.envelopes).toHaveLength(1);
        expect(inbox.envelopes[0]).toContain("My message disappeared");
        expect(inbox.bodies[0]?.includes(Buffer.from(pngBytes))).toBe(true);
    } finally {
        await inbox.close();
    }
});

test("Given a native handoff cannot find its Agent, When the user reports the displayed error, Then the report includes its code and attempts daemon diagnostics for that Computer", {
    timeout: 30_000,
}, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-10T07:21:00Z"));
    const inbox = await createReportInbox();
    try {
        const app = await createTestApp({ page: { kind: "continue", harness: "pi", sessionId: "native-session" } });
        await app.waitForView(() => {
            expect(getByRole(document.body, "alert").textContent).toContain("Connect an Agent to this Computer first.");
        });
        await app.user.click(getByRole(document.body, "button", { name: "Report a bug" }));
        await app.user.type(getByRole(document.body, "textbox", { name: "What went wrong?" }), "Cannot continue Pi");
        await app.user.click(getByRole(document.body, "button", { name: "Send report" }));
        await visibleMessage(document.body, "status", "Report sent");
        const envelope = inbox.envelopes[0] ?? "";
        const report = JSON.parse(envelope.trim().split("\n").at(-1) ?? "null");
        expect(report).toMatchObject({
            computerId: app.computerId,
            sessionId: "native-session",
            daemon: { kind: "unavailable", code: "AGENT_REQUIRED" },
            network: {
                measurements: {
                    browserMorty: { kind: "available", latencyMs: expect.any(Number) },
                    mortyComputer: { kind: "unavailable" },
                },
            },
        });
        expect(report.web.entries).toContainEqual(
            expect.objectContaining({
                component: "web",
                operation: "continue-native-session",
                outcome: "AGENT_REQUIRED",
                requestId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
            }),
        );
        expect(envelope).not.toContain("Connect an Agent to this Computer first.");
        await app.close();
        render(
            <App
                bugReportDialog={
                    createMortyApplication({ origin: window.location.origin, transport: noopTransport() })
                        .bugReportDialog
                }
                state={{ kind: "failed", retry: () => window.location.reload(), retrying: false }}
            />,
        );
        const user = userEvent.setup();
        await user.click(getByRole(document.body, "button", { name: "Report a bug" }));
        await user.type(getByRole(document.body, "textbox", { name: "What went wrong?" }), "Another page failed");
        await user.click(getByRole(document.body, "button", { name: "Send report" }));
        await visibleMessage(document.body, "status", "Report sent");
        const afterUnmount = JSON.parse((inbox.envelopes[1] ?? "").trim().split("\n").at(-1) ?? "null");
        expect(afterUnmount).toMatchObject({
            computerId: null,
            sessionId: null,
            daemon: { kind: "unavailable", code: "NO_ACTIVE_COMPUTER" },
        });
    } finally {
        await inbox.close();
        vi.useRealTimers();
    }
});

test("Given two Computer views are mounted, When a user reports from the first view, Then diagnostics identify that view's Computer instead of the last mounted Computer", {
    timeout: 30_000,
}, async () => {
    const inbox = await createReportInbox();
    try {
        const first = await createTestApp({ connectAgent: true });
        const reportButton = await first.waitForView(() => {
            if (document.querySelector('main[aria-label="Chat"]') === null) {
                throw new Error("The chat page did not appear.");
            }
            return getByRole(document.body, "button", { name: "Report a bug" });
        });
        const second = await createTestApp({ connectAgent: true });
        await second.waitForView(() =>
            expect(getAllByRole(document.body, "button", { name: "Report a bug" })).toHaveLength(2),
        );
        await first.user.click(reportButton);
        const dialog = getByRole(document.body, "dialog", { name: "Report a bug" });
        await first.user.type(getByRole(dialog, "textbox", { name: "What went wrong?" }), "The first Computer is slow");
        await first.user.click(getByRole(dialog, "button", { name: "Send report" }));
        await visibleMessage(dialog, "status", "Report sent");
        const report = JSON.parse((inbox.envelopes[0] ?? "").trim().split("\n").at(-1) ?? "null");
        expect(report.computerId).toBe(first.computerId);
        expect(report.computerId).not.toBe(second.computerId);
        expect(report.daemon.kind).toBe("available");
        expect(report.network.measurements.mortyComputer.kind).toBe("available");
    } finally {
        await inbox.close();
    }
});
