import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { afterAll, expect, it, vi } from "vitest";
import { SessionAccessSigner } from "../../src/computer-relay/components/runtime/entity/session-access-credential.ts";
import { acceptWebSocketHttpTransport } from "../../src/computer-relay/components/runtime/http/websocket-http-transport.ts";
import { createLocalSessionOperations } from "../../src/computer-relay/components/runtime/service/local-session-operations.ts";
import { SessionAccessService } from "../../src/computer-relay/components/runtime/service/session-access-service.ts";
import { createSessionWebSocketRoutes } from "../../src/computer-relay/components/runtime/websocket/session-websocket-routes.ts";
import { createRelayDurableObjectContext } from "../../src/computer-relay/composition/relay-durable-object-context.ts";
import { DurableObjectDatabase } from "../../src/computer-relay/infra/durable-object-database.ts";
import { computerObjectName } from "../../src/contracts/computer-id.ts";
import { RequestDeadline } from "../../src/http/request-deadline.ts";
import { createOwner, ownerOrigin } from "./owner-fixture.ts";
import { computerAccess } from "./registered-computer.ts";

/** A stateful downstream application boundary whose response is released by the scenario. */
class PendingComputerApiBoundary {
    readonly requested = Promise.withResolvers<void>();
    readonly response = Promise.withResolvers<Response>();

    readonly fetch = async (request: Request): Promise<Response> => {
        using deadline = new RequestDeadline(request.signal, 120_000);
        this.requested.resolve();
        return await deadline.wait(this.response.promise);
    };
}

afterAll(abortAllDurableObjects);

it("Given a Computer API with a 120-second deadline mounted beside Session routes, When it finishes after 45 seconds over WebSocket, Then its response succeeds without inheriting the Session deadline", async () => {
    const owner = await createOwner();
    vi.useFakeTimers({ now: new Date("2026-11-12T00:00:00.000Z") });
    try {
        await runInDurableObject(
            env.COMPUTER_RELAY.getByName(computerObjectName(owner.computerId)),
            async (_instance, state) => {
                const { access } = computerAccess(owner.computerId, state.storage);
                const runtime = createRelayDurableObjectContext(state, {
                    database: new DurableObjectDatabase(state.storage),
                    access: () => access,
                });
                const api = new PendingComputerApiBoundary();
                const router = createSessionWebSocketRoutes({
                    ownsComputer: (computerId) => computerId === owner.computerId,
                    services: {
                        forComputer: (computerId) => ({
                            sessions: new SessionAccessService(
                                access,
                                new SessionAccessSigner(env.MORTY_SESSION_SIGNING_SECRET),
                            ),
                            operations: createLocalSessionOperations(runtime, computerId),
                        }),
                    },
                }).route(
                    "/",
                    new Hono().post("/morty/api/v1/computers/:computerId/agent-settings", (context) =>
                        api.fetch(context.req.raw),
                    ),
                );
                const response = acceptWebSocketHttpTransport({
                    request: new Request(`${ownerOrigin}/morty/api/v1/computers/${owner.computerId}/transport`, {
                        headers: { Upgrade: "websocket" },
                    }),
                    dispatch: async (operation) => await router.fetch(operation.request, { operation }),
                });
                const socket = response.webSocket;
                if (socket === null) {
                    throw new Error("Expected a WebSocket transport");
                }
                socket.accept();
                try {
                    const received = new Promise<unknown>((resolve) =>
                        socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), {
                            once: true,
                        }),
                    );
                    socket.send(
                        JSON.stringify({
                            kind: "http.request",
                            requestId: "slow-settings",
                            method: "POST",
                            path: `/morty/api/v1/computers/${owner.computerId}/agent-settings`,
                            headers: [],
                            body: "{}",
                        }),
                    );
                    await api.requested.promise;
                    await vi.advanceTimersByTimeAsync(45_000);
                    api.response.resolve(Response.json({ settings: [] }));
                    expect(await received).toMatchObject({
                        kind: "http.response",
                        requestId: "slow-settings",
                        status: 200,
                        body: JSON.stringify({ settings: [] }),
                    });
                } finally {
                    socket.close(1000, "Test complete");
                }
            },
        );
    } finally {
        vi.useRealTimers();
    }
});
