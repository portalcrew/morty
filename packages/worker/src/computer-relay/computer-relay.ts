import { DurableObject } from "cloudflare:workers";
import {
    COMPUTER_HEARTBEAT_ACK_MESSAGE,
    COMPUTER_HEARTBEAT_MESSAGE,
    COMPUTER_SUCCESSOR_CREDENTIAL_HEADER,
    isComputerCredentialSuccessor,
} from "@portalcrew/morty-client/protocol";
import { Hono } from "hono";
import { computerIdFromPrefixedValue, computerIdPrefix, computerObjectName } from "../contracts/computer-id.ts";
import { ComputerManagementError } from "../contracts/computer-management.ts";
import { computerNotFound } from "../contracts/management-error.ts";
import { hashPairingCredential } from "../contracts/relay/pairing.ts";
import type { ConfiguredRelayBindings } from "../contracts/relay-bindings.ts";
import { errorHandler } from "../http/error-middleware.ts";
import { RequestDeadline } from "../http/request-deadline.ts";
import { readBearerToken } from "../http/request-headers.ts";
import { logger } from "../infra/logger.ts";
import { ComputerBackendService } from "./components/computer/service/computer-backend-service.ts";
import { credentialRejected } from "./components/management/http/authenticated-session.ts";
import { ComputerAccessService } from "./components/management/service/computer-access-service.ts";
import { ComputerRelayStore } from "./components/management/storage/computer-relay-store.ts";
import { DurableComputerAccount } from "./components/management/storage/durable-computer-account.ts";
import { DurableCredentialKey } from "./components/management/storage/durable-credential-key.ts";
import { IdentityStorage } from "./components/management/storage/identity-storage.ts";
import { heldRetiredPairing } from "./components/management/storage/retired-layout-pairing.ts";
import { DaemonWebSocketRoutes } from "./components/runtime/daemon-websocket-routes.ts";
import { CloudflareBrowserTransports } from "./components/runtime/gateway/cloudflare-browser-transports.ts";
import { daemonSocketComputerId } from "./components/runtime/gateway/cloudflare-relay-peers.ts";
import { createLocalSessionOperations } from "./components/runtime/service/local-session-operations.ts";
import {
    createComputerHttpApplication,
    createComputerWebSocketApplication,
} from "./composition/computer-application.ts";
import type { ComputerRouteContext } from "./composition/computer-route-context.ts";
import { ComputerServices } from "./composition/computer-services.ts";
import { createRelayDurableObjectContext } from "./composition/relay-durable-object-context.ts";
import { createComputerRelayServices } from "./composition/relay-services.ts";
import type { ComputerRouteHttpEnvironment } from "./http/environment.ts";
import { retiredPairingLookup } from "./http/retired-daemon.ts";
import { createComputerHttpRoutes } from "./http/routes.ts";
import { DurableObjectDatabase } from "./infra/durable-object-database.ts";

const REAUTHORIZATION_INTERVAL_MILLISECONDS = 60_000;

/**
 * Owns one computer's storage. Requests routed to the computer run here against that storage, and every other
 * Worker or Durable Object reaches it only through its HTTP boundary.
 */
export class ComputerRelay extends DurableObject<ConfiguredRelayBindings> {
    #store: ComputerRelayStore | null = null;
    readonly #account = new DurableComputerAccount(this.ctx.storage);
    readonly #credentialKey = new DurableCredentialKey(this.ctx.storage);

    readonly #browserServices = new ComputerServices(
        (id) => this.#owns(id),
        (change) => this.#endAccess(change),
        this.#credentialKey.read,
        () => this.#routes.browser.announce("linked-devices"),
        (computerId) => this.#backendServices(computerId),
        () => this.#computerDatabase,
        (write) => this.#commitCreation(write),
    );

    readonly #routes = this.#createRoutes();

    #createRoutes() {
        const storeFor = (computerId: string) => {
            const store = this.#computerStore(computerId);
            if (store === null) {
                throw new ComputerManagementError("computer_id_mismatch", "The computer is unavailable", 421);
            }
            return store;
        };
        const ctx: ComputerRouteContext = {
            bindings: this.env,
            ownsComputer: (computerId) => this.#owns(computerId),
            holdsComputer: () => this.#account.holdsAccount(),
            services: {
                browser: this.#browserServices,
                relay: (computerId) => this.#services(computerId, storeFor(computerId)).relay,
                sessions: (computerId) => ({
                    sessions: this.#services(computerId, storeFor(computerId)).access.sessionAccess,
                    operations: createLocalSessionOperations(this.#connectionsFor(computerId).context),
                }),
            },
            utilities: {
                connectionOpened: () => this.#scheduleConnectionChecks(),
            },
        };
        const httpApplication = createComputerHttpApplication(ctx);
        const websocketApplication = createComputerWebSocketApplication(ctx);
        const browser = new CloudflareBrowserTransports(
            this.ctx,
            {
                ...websocketApplication,
                restore: (computerId, identity, observer, signal) =>
                    ctx.services.sessions(computerId).operations.restoreSessionEvents(identity, observer, signal),
                follow: async (computerId, credential, signal) => {
                    const authenticated = await this.#browserServices
                        .forComputer(computerId, this.env)
                        .services.authentication.session(credential, signal);
                    if (authenticated.kind !== "authenticated") {
                        throw credentialRejected(authenticated.kind);
                    }
                    return { holder: authenticated.holder, accessExpiresAt: authenticated.accessExpiresAt };
                },
            },
            (computerId) => this.#connectionsFor(computerId),
            () => this.#scheduleConnectionChecks(),
        );
        const http = new Hono<ComputerRouteHttpEnvironment>()
            .onError(errorHandler)
            .route("/", createComputerHttpRoutes(ctx, httpApplication, browser))
            .notFound(() =>
                Response.json(
                    { error: { code: "not_found", message: "The requested Morty resource does not exist" } },
                    { status: 404 },
                ),
            );
        return { http, browser };
    }
    #connections:
        | {
              readonly context: ReturnType<typeof createRelayDurableObjectContext>;
              readonly daemonWebSocket: DaemonWebSocketRoutes;
          }
        | undefined;

    constructor(state: DurableObjectState, environment: ConfiguredRelayBindings) {
        super(state, environment);
        state.setWebSocketAutoResponse(
            new WebSocketRequestResponsePair(COMPUTER_HEARTBEAT_MESSAGE, COMPUTER_HEARTBEAT_ACK_MESSAGE),
        );
    }

    #createConnections(computerId: string) {
        const context = createRelayDurableObjectContext(this.ctx, {
            computerId,
            database: this.#computerDatabase,
            access: () => this.#accessFor(computerId),
            computerChanged: this.#computerChanged,
        });
        return {
            context,
            daemonWebSocket: new DaemonWebSocketRoutes(
                context,
                logger.child({
                    computerId,
                    durableObjectClass: "ComputerRelay",
                    durableObjectId: this.ctx.id.toString(),
                    runtimeInstanceId: crypto.randomUUID(),
                    runtimeInstanceStartedAt: Date.now(),
                }),
            ),
        };
    }

    #connectionsFor(computerId: string) {
        if (!this.#owns(computerId)) {
            throw new ComputerManagementError("computer_id_mismatch", "The computer is unavailable", 421);
        }
        if (this.#connections === undefined) {
            this.#connections = this.#createConnections(computerId);
            // A Relay that woke from hibernation still holds its browser connections; their viewers must be back
            // before the daemon's next event is routed.
            this.#routes.browser.restore();
        }
        return this.#connections;
    }

    #daemonRoutes(socket: WebSocket) {
        return this.#connectionsFor(daemonSocketComputerId(socket)).daemonWebSocket;
    }

    #database: DurableObjectDatabase | undefined;
    /** Opening the database creates its schema, so only a computer that was created has one. */
    get #computerDatabase(): DurableObjectDatabase {
        if (!this.#account.holdsAccount()) {
            throw computerNotFound();
        }
        this.#database ??= new DurableObjectDatabase(this.ctx.storage);
        return this.#database;
    }

    /**
     * Creates the computer this object holds: its existence and what `write` stores with it, such as its owner's
     * credential, commit as one transaction. A computer never exists without its owner, and a creation that fails leaves
     * neither the computer nor its database behind.
     */
    #commitCreation<Value>(write: (database: DurableObjectDatabase) => Value): Value {
        const created = this.ctx.storage.transactionSync(() => {
            this.#account.create();
            const database = this.#database ?? new DurableObjectDatabase(this.ctx.storage);
            return { database, value: write(database) };
        });
        // Opening the database migrated it inside the transaction, so it is kept only once that committed.
        this.#database = created.database;
        return created.value;
    }

    #computerStore(computerId: string): ComputerRelayStore | null {
        if (!this.#owns(computerId)) {
            return null;
        }
        if (this.#store === null) {
            this.#store = new ComputerRelayStore(this.#computerDatabase);
        }
        return this.#store;
    }

    #owns(computerId: string): boolean {
        return this.env.COMPUTER_RELAY.idFromName(computerObjectName(computerId)).toString() === this.ctx.id.toString();
    }

    #operate(computerId: string): ComputerRelayStore {
        const store = computerIdPrefix(computerId) === null ? null : this.#computerStore(computerId);
        if (store === null) {
            throw new Error("The computer is unavailable");
        }
        return store;
    }

    /**
     * Commits an identity change that may end access to the computer, and with it the connection check that closes the
     * live views the change no longer authorizes. Requests read the identities, so the committed
     * change is already in force; the check only ends the open connections, and the alarm retries it until it runs.
     */
    readonly #endAccess = async (change: () => Promise<boolean>): Promise<boolean> => {
        const ended = await this.ctx.storage.transaction(async (transaction) => {
            if (!(await change())) {
                return false;
            }
            await transaction.setAlarm(Date.now());
            return true;
        });
        if (ended) {
            this.#routes.browser.announce("computer");
            this.#routes.browser.announce("linked-devices");
        }
        return ended;
    };

    /** Tells followers the Computer changed, and keeps checking on it while they follow. */
    readonly #computerChanged = (): void => {
        this.#routes.browser.announce("computer");
        this.ctx.waitUntil(this.#scheduleConnectionChecks());
    };

    override async fetch(request: Request): Promise<Response> {
        if (request.method === "POST" && request.url === retiredPairingLookup) {
            const token = readBearerToken(request.headers);
            const id = computerIdFromPrefixedValue(token ?? "");
            const successor = request.headers.get(COMPUTER_SUCCESSOR_CREDENTIAL_HEADER) ?? "";
            if (
                id === null ||
                token === undefined ||
                !isComputerCredentialSuccessor(token, successor) ||
                this.env.COMPUTER_RELAY.idFromName(id).toString() !== this.ctx.id.toString()
            ) {
                return new Response(null, { status: 404 });
            }
            // A daemon can have persisted the successor just before losing the acknowledgement of rotation.
            const hashes = await Promise.all([hashPairingCredential(token), hashPairingCredential(successor)]);
            const held = heldRetiredPairing(this.ctx.storage, hashes);
            return new Response(null, { status: held ? 204 : 404 });
        }
        const response = await this.#routes.http.fetch(request, this.env);
        if (response.status === 101 && this.#account.holdsAccount()) {
            await this.#scheduleConnectionChecks();
        }
        return response;
    }

    #access: ComputerAccessService | undefined;
    /** The access of the computer this object holds; `computerId` must name that computer. */
    #accessFor(computerId: string): ComputerAccessService {
        const store = this.#operate(computerId);
        this.#access ??= new ComputerAccessService(
            computerId,
            store,
            new IdentityStorage(this.#computerDatabase, computerId),
        );
        return this.#access;
    }

    #servicesCache: ReturnType<typeof createComputerRelayServices> | undefined;
    #services(computerId: string, store: ComputerRelayStore) {
        this.#servicesCache ??= createComputerRelayServices(
            this.env,
            computerId,
            store,
            this.#connectionsFor(computerId).context.services.runtime,
            this.#accessFor(computerId),
            this.#credentialKey.read,
            this.#computerChanged,
        );
        return this.#servicesCache;
    }

    #backendServices(computerId: string): ComputerBackendService {
        const { access, relay } = this.#services(computerId, this.#operate(computerId));
        return new ComputerBackendService(
            computerId,
            relay,
            access.sessionAccess,
            createLocalSessionOperations(this.#connectionsFor(computerId).context),
        );
    }

    /**
     * Sets the alarm for the earliest open connection check: a viewer's expiry, the next re-authorization of the
     * viewers, or a browser connection falling silent. A pending check that is earlier is kept, so new connections
     * never postpone it.
     */
    readonly #scheduleConnectionChecks = async (): Promise<void> => {
        const viewers = this.#connections?.context.gateways.peers.viewers() ?? [];
        const checks = viewers.map(({ identity }) => identity.expiresAt);
        if (viewers.length > 0) {
            checks.push(Date.now() + REAUTHORIZATION_INTERVAL_MILLISECONDS);
        }
        const silence = this.#routes.browser.nextSilenceCheck();
        if (silence !== null) {
            checks.push(silence);
        }
        const follows = this.#routes.browser.follows();
        if (follows.length > 0) {
            // Nothing reads the Computer while its followers wait, so its silence is checked for them.
            const daemonSilence = this.#connections?.context.services.runtime.silenceDeadline() ?? null;
            if (daemonSilence !== null) {
                checks.push(daemonSilence);
            }
            for (const { follow } of follows) {
                if (follow.accessExpiresAt !== null) {
                    checks.push(follow.accessExpiresAt);
                }
            }
        }
        if (checks.length === 0) {
            await this.ctx.storage.deleteAlarm();
            return;
        }
        // An alarm that is already due (the one running now) is not a pending check.
        const scheduled = await this.ctx.storage.getAlarm();
        const pending = scheduled !== null && scheduled > Date.now() ? scheduled : Number.POSITIVE_INFINITY;
        await this.ctx.storage.setAlarm(Math.min(...checks, pending));
    };

    override async alarm(): Promise<void> {
        // The alarm may wake a hibernated Relay that forgot its browser connections and their viewers.
        this.#routes.browser.wake();
        this.#routes.browser.closeSilent(Date.now());
        if (this.#routes.browser.follows().length > 0) {
            using deadline = new RequestDeadline(new AbortController().signal, 30_000);
            await this.#connections?.context.services.runtime.expireSilentDaemons();
            await this.#routes.browser.recheckFollows(
                async (computerId, follow) =>
                    await this.#accessFor(computerId).accessStanding(follow.holder, deadline.signal),
            );
        }
        try {
            await this.#connections?.daemonWebSocket.reauthorizeConnections();
        } finally {
            await this.#scheduleConnectionChecks();
        }
    }

    override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
        if (this.#routes.browser.owns(socket)) {
            await this.#routes.browser.receive(socket, message);
            return;
        }
        await this.#daemonRoutes(socket).webSocketMessage(socket, message);
    }

    override async webSocketClose(socket: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
        if (this.#routes.browser.owns(socket)) {
            this.#routes.browser.closed(socket, 1000, "WebSocket transport closed");
            return;
        }
        await this.#daemonRoutes(socket).webSocketClose(socket, { code, reason, wasClean });
    }

    override webSocketError(socket: WebSocket, error: unknown): void {
        if (this.#routes.browser.owns(socket)) {
            this.#routes.browser.closed(socket, 1011, "WebSocket transport failed");
            return;
        }
        try {
            this.#daemonRoutes(socket).webSocketError(socket, error);
        } catch (cause) {
            logger.error({ err: cause, event: "computer_websocket_error_unattributed" }, "Computer WebSocket error");
            socket.close(1011, "WebSocket error");
        }
    }
}
