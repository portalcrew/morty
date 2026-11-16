import { logger } from "../../../infra/logger.ts";
import type { DurableObjectDatabase } from "../../infra/durable-object-database.ts";
import type { ComputerAccessService } from "../management/service/computer-access-service.ts";
import { ComputerCredentialService } from "./service/computer-credential-service.ts";
import { ComputerRelayActor } from "./service/computer-relay-actor.ts";
import { type ComputerPeers, ComputerService } from "./service/computer-service.ts";
import { DaemonConnectionService } from "./service/daemon-connection-service.ts";
import { LocalComputerRequests } from "./service/local-computer-requests.ts";
import { LocalSessionViewers } from "./service/local-session-viewers.ts";
import { ComputerConnectionStorage } from "./storage/computer-connection-storage.ts";

export type RuntimeContext = ReturnType<typeof createRuntimeContext>;

export function createRuntimeContext(cx: {
    readonly computerId: string;
    readonly doDatabase: DurableObjectDatabase;
    readonly services: {
        readonly access: () => ComputerAccessService;
    };
    readonly gateways: {
        readonly peers: Omit<ComputerPeers, "operations" | "daemons" | "viewers">;
    };
    readonly utilities: {
        readonly waitUntil: (operation: Promise<void>) => void;
    };
}) {
    const requests = new LocalComputerRequests(cx.utilities.waitUntil);
    const viewers = new LocalSessionViewers((identity) => runtime.detachViewer(identity));
    const source = cx.gateways.peers;
    const peers: ComputerPeers = {
        accept: source.accept,
        daemonConnections: source.daemonConnections,
        // Which daemon is current is the connection record's fact, so the daemons are the one it names.
        daemons: () => {
            const daemon = runtime.currentDaemon();
            return daemon === undefined ? [] : [daemon.socket];
        },
        viewers: viewers.viewers,
        operations: requests.routes,
    };
    const credentials = new ComputerCredentialService(cx.computerId, cx.services.access);
    const connections = new DaemonConnectionService(new ComputerConnectionStorage(cx.doDatabase));
    const runtime = new ComputerService({
        services: {
            credentials,
            connections,
            relay: new ComputerRelayActor({ config: { computerId: cx.computerId }, gateways: { peers } }),
        },
        gateways: { peers },
        utilities: cx.utilities,
        logger: logger.child({ computerId: cx.computerId }),
    });
    return {
        gateways: { peers, requests, viewers },
        utilities: cx.utilities,
        services: { connections, runtime },
    };
}
