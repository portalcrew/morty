import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { getByTestId, getConfig, queryAllByTestId } from "@testing-library/dom";
import { act, render } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { flushSync } from "react-dom";
import * as v from "valibot";
import { afterAll, afterEach } from "vitest";
import type { ControlledAgent } from "../../../../tests/support/fake-daemon/runtime.ts";
import type { SetupHandoff } from "../../src/services/device/setup-handoff.ts";
import { encodeIdentityScope, identityScopeSchema } from "../../src/services/identity/identity-scope-url.ts";
import { withStoredAccessLock } from "../../src/services/identity/remembered-computers.ts";
import type { Clock } from "../../src/services/time/clock.ts";
import { assembleMorty } from "../../src/views/bootstrap.tsx";
import { createChatWorkerEnvironment } from "../support/chat-worker.ts";
import { TestApiTransport } from "../support/test-api-transport.ts";

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * happy-dom aliases PageTransitionEvent to Event, which drops `persisted`, so a page restored from the back/forward
 * cache would look like a fresh load and Morty's restore path would never run. Browsers carry it; so do the tests.
 */
class BrowserPageTransitionEvent extends Event {
    readonly persisted: boolean;

    constructor(type: string, init: PageTransitionEventInit = {}) {
        super(type, init);
        this.persisted = init.persisted ?? false;
    }
}
Object.defineProperty(globalThis, "PageTransitionEvent", { value: BrowserPageTransitionEvent, configurable: true });
Object.defineProperty(window, "PageTransitionEvent", { value: BrowserPageTransitionEvent, configurable: true });

type Environment = Awaited<ReturnType<typeof createChatWorkerEnvironment>>;
type Application = Awaited<ReturnType<Environment["createApplication"]>>;

const environment = createChatWorkerEnvironment();
const activeApps = new Set<TestApp>();

export interface TestApp extends Application {
    readonly reload: () => Promise<TestApp>;
    readonly daemon: Awaited<ReturnType<Application["connectAgent"]>> | null;
    readonly agentFailure: Promise<never> | null;
    readonly close: () => Promise<void>;
    readonly elementByTestId: (testId: string | RegExp, container?: HTMLElement) => HTMLElement;
    readonly elementsByTestId: (testId: string | RegExp) => HTMLElement[];
    readonly optionalElementByTestId: (testId: string | RegExp) => HTMLElement | null;
    readonly remount: () => void;
    readonly openViewer: () => Promise<TestApp>;
    readonly queryElementByTestId: (
        testId: string | RegExp,
        accept?: (element: HTMLElement) => boolean,
    ) => Promise<HTMLElement>;
    readonly waitForView: <T>(read: () => T, timeoutMs?: number) => Promise<T>;
    readonly user: UserEvent;
}

export async function createTestApp(
    options: {
        readonly application?: Application;
        readonly environment?: Environment;
        readonly connectAgent?: boolean;
        readonly clock?: Clock;
        /** How the device moves setup to the agent's computer; defaults to the test browser's own. */
        readonly setupHandoff?: SetupHandoff;
        readonly agent?: ControlledAgent;
        readonly agents?: readonly ControlledAgent[];
        readonly sessionIds?: ReadonlySet<string>;
        readonly page?:
            | {
                  readonly kind: "continue";
                  readonly harness: string;
                  readonly sessionId: string;
                  /** The directory setup ran in; defaults to the system temporary directory. */
                  readonly workspace?: string;
                  /** Replaces the created transfer code, for example with one that cannot be redeemed. */
                  readonly code?: (application: Application) => string;
              }
            | { readonly kind: "share"; readonly code?: (application: Application) => string }
            | { readonly kind: "bootstrap"; readonly identity?: boolean }
            | { readonly kind: "reload" }
            | { readonly kind: "url"; readonly path: string }
            | { readonly kind: "managed-session"; readonly harness: string; readonly sessionId: string }
            | { readonly kind: "morty" };
        readonly prepare?: (application: Application) => void | Promise<void>;
    } = {},
): Promise<TestApp> {
    const current = options.application ?? (await (options.environment ?? (await environment)).createApplication());
    await options.prepare?.(current);
    const daemon =
        options.connectAgent === true
            ? options.agents === undefined
                ? await current.connectAgent(options.agent, options.sessionIds)
                : await current.connectAgents(options.agents, options.sessionIds)
            : null;
    const agentFailure = daemon?.failure ?? null;
    const page = options.page ?? { kind: "morty" };
    if (page.kind === "continue" || page.kind === "share") {
        const transfer = new URL(await current.createTransferUrl());
        if (page.kind === "continue") {
            transfer.searchParams.set("harness", page.harness);
            transfer.searchParams.set("sessionId", page.sessionId);
            transfer.searchParams.set("workspace", page.workspace ?? (await realpath(tmpdir())));
        }
        if (page.code !== undefined) {
            transfer.hash = `code=${page.code(current)}`;
        }
        window.location.href = transfer.href;
    } else if (page.kind === "url") {
        window.location.href = new URL(page.path, current.origin).href;
    } else if (page.kind === "bootstrap") {
        const destination = new URL("/", current.origin);
        if (page.identity === true) {
            const scope = v.parse(identityScopeSchema, {
                computerId: current.identity.computerId,
            });
            destination.searchParams.set("identity", encodeIdentityScope(scope));
            await saveAccess(
                scope,
                await current.identity.getToken(new AbortController().signal),
                new AbortController().signal,
            );
        }
        window.location.href = destination.href;
    } else if (options.application === undefined) {
        const destination = new URL("/chat", current.origin);
        if (page.kind === "managed-session") {
            destination.searchParams.set("harness", page.harness);
            destination.searchParams.set("sessionId", page.sessionId);
        }
        // Sign in through the production flow: the URL carries the identity
        // scope and storage carries the access a shared-access link saves, so
        // the anonymous session restores it on load.
        const scope = v.parse(identityScopeSchema, {
            computerId: current.identity.computerId,
        });
        destination.searchParams.set("identity", encodeIdentityScope(scope));
        await saveAccess(
            scope,
            await current.identity.getToken(new AbortController().signal),
            new AbortController().signal,
        );
        window.location.href = destination.href;
    }
    let container = document.createElement("div");
    // The same assembly production uses: one application, the continuation
    // router, toast host, and error boundary. Assembled once so a remount
    // re-renders the same application, exactly like a production page reload
    // remount.
    const assembled = assembleMorty({
        origin: current.origin,
        transport: current.transport,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.setupHandoff === undefined ? {} : { setupHandoff: options.setupHandoff }),
    });
    let rendered: { readonly unmount: () => void } = { unmount: () => {} };
    const mount = () => {
        container.setAttribute("data-test-app-root", "");
        document.body.appendChild(container);
        // Development renders under StrictMode, which replays every mount; so does every scenario.
        rendered = render(assembled.element, { container, reactStrictMode: true });
    };
    mount();
    let closed = false;
    const lifetime = new AbortController();
    // Use RTL's async boundary to settle external updates and pending microtasks.
    // DOM observation keeps this wait event-driven rather than polling the network.
    const waitForView = <T,>(read: () => T, timeoutMs = 12_000): Promise<T> =>
        getConfig().asyncWrapper(
            () =>
                new Promise<T>((resolve, reject) => {
                    let lastFailure: unknown;
                    const cleanup = () => {
                        observer.disconnect();
                        window.removeEventListener("hashchange", check);
                        clearTimeout(deadline);
                        lifetime.signal.removeEventListener("abort", abort);
                    };
                    const abort = () => {
                        cleanup();
                        reject(lifetime.signal.reason);
                    };
                    const check = () => {
                        try {
                            const result = read();
                            cleanup();
                            resolve(result);
                        } catch (cause) {
                            lastFailure = cause;
                        }
                    };
                    const observer = new MutationObserver(check);
                    const deadline = setTimeout(() => {
                        cleanup();
                        reject(lastFailure ?? new Error("The expected view did not appear."));
                    }, timeoutMs);
                    if (lifetime.signal.aborted) {
                        abort();
                        return;
                    }
                    lifetime.signal.addEventListener("abort", abort, { once: true });
                    observer.observe(document.body, {
                        attributes: true,
                        characterData: true,
                        childList: true,
                        subtree: true,
                    });
                    // A completed handoff removes the transfer-code hash without
                    // changing the old document before its navigation is followed.
                    window.addEventListener("hashchange", check);
                    check();
                }),
        );
    const matchingElements = (testId: string | RegExp): HTMLElement[] =>
        queryAllByTestId(document.body, testId).filter(
            (element) => container.contains(element) || element.closest("[data-test-app-root]") === null,
        );
    const optionalElement = (testId: string | RegExp): HTMLElement | null => {
        const matches = matchingElements(testId);
        if (matches.length > 1) {
            throw new Error(`Multiple elements match ${String(testId)}`);
        }
        return matches[0] ?? null;
    };
    const requiredElement = (testId: string | RegExp): HTMLElement => {
        const element = optionalElement(testId);
        if (element === null) {
            throw new Error(`Missing ${String(testId)}; page: ${document.body.textContent}`);
        }
        return element;
    };

    const app: TestApp = {
        ...current,
        agentFailure,
        daemon:
            daemon === null
                ? null
                : {
                      ...daemon,
                      continueReply: async (...args) => {
                          await daemon.continueReply(...args);
                          // Let the host scheduler accept the reply, then commit the
                          // view synchronously so a large message is visible to the test.
                          await new Promise((resolve) => {
                              setTimeout(resolve, 0);
                          });
                          flushSync(() => undefined);
                      },
                  },
        reload: async () => {
            closed = true;
            lifetime.abort(new DOMException("The test document reloaded", "AbortError"));
            rendered.unmount();
            container.remove();
            assembled.application.dispose();
            activeApps.delete(app);
            // A real reload gets a fresh page with its own Chat API
            // transport; the reloaded document keeps the live server and
            // Computer fixtures but replaces the disposed transport so a
            // late close from the old socket cannot reject its requests.
            const transport = new TestApiTransport(current.origin);
            transport.open();
            return await createTestApp({
                application: { ...current, transport, close: () => transport.dispose() },
                page: { kind: "reload" },
                ...(options.clock === undefined ? {} : { clock: options.clock }),
            });
        },
        openViewer: async () => {
            const transport = new TestApiTransport(current.origin);
            transport.open();
            return await createTestApp({
                application: { ...current, transport, close: () => transport.dispose() },
                ...(options.clock === undefined ? {} : { clock: options.clock }),
            });
        },
        close: async () => {
            if (closed) {
                return;
            }
            closed = true;
            lifetime.abort(new DOMException("The test application closed", "AbortError"));
            rendered.unmount();
            // The assembly owns the identity lifetime, the chat API, and the
            // transport; disposing it also closes the shared transport, which
            // is fine here because current.close() closes it anyway and
            // viewers own their own transports.
            assembled.application.dispose();
            await current.close();
            container.remove();
            activeApps.delete(app);
        },
        elementByTestId: (testId, scope) =>
            scope === undefined ? requiredElement(testId) : getByTestId(scope, testId),
        elementsByTestId: matchingElements,
        optionalElementByTestId: optionalElement,
        remount: () => {
            rendered.unmount();
            container.remove();
            container = document.createElement("div");
            mount();
        },
        queryElementByTestId: async (testId, accept = () => true) =>
            await waitForView(() => {
                const element = requiredElement(testId);
                if (!accept(element)) {
                    throw new Error(`Element was not ready: ${String(testId)}; page: ${document.body.textContent}`);
                }
                return element;
            }),
        waitForView,
        user: userEvent.setup(),
    };
    activeApps.add(app);
    return app;
}

async function closeTestApps(): Promise<void> {
    await act(async () => {
        await Promise.all([...activeApps].map(async (app) => await app.close()));
    });
}

async function closeTestEnvironment(): Promise<void> {
    await (await environment).close();
}

afterEach(async () => {
    await closeTestApps();
    document.body.replaceChildren();
    document.documentElement.removeAttribute("data-input-modality");
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
});

afterAll(async () => {
    await closeTestEnvironment();
});

async function saveAccess(
    scope: Parameters<import("../../src/services/identity/remembered-computers.ts").StoredAccessWriter["save"]>[0],
    token: string,
    signal: AbortSignal,
): Promise<void> {
    await withStoredAccessLock(signal, async (access) => access.save(scope, token));
}
