import type { DurableObjectDatabase } from "../../infra/durable-object-database.ts";
import type { ComputerAccessService } from "../management/service/computer-access-service.ts";
import { ComputerCredentialService } from "./service/computer-credential-service.ts";
import { ComputerRelayActor } from "./service/computer-relay-actor.ts";
import { type ComputerPeers, ComputerService } from "./service/computer-service.ts";
import { DaemonConnectionService } from "./service/daemon-connection-service.ts";
import { LocalComputerRequests } from "./service/local-computer-requests.ts";
import { ComputerConnectionStorage } from "./storage/computer-connection-storage.ts";

export type RuntimeContext = ReturnType<typeof createRuntimeContext>;

export function createRuntimeContext(cx: {
    readonly doDatabase: DurableObjectDatabase;
    readonly services: {
        readonly access: (computerId: string) => ComputerAccessService;
    };
    readonly gateways: {
        readonly peers: Omit<ComputerPeers, "operations">;
    };
    readonly utilities: {
        readonly waitUntil: (operation: Promise<void>) => void;
    };
}) {
    const requests = new LocalComputerRequests(cx.utilities.waitUntil);
    const source = cx.gateways.peers;
    const peers: ComputerPeers = {
        accept: source.accept,
        sockets: source.sockets,
        daemonConnections: source.daemonConnections,
        daemons: source.daemons,
        viewers: source.viewers,
        operations: requests.routes,
    };
    const credentials = new ComputerCredentialService(cx.services.access);
    const connections = new DaemonConnectionService(new ComputerConnectionStorage(cx.doDatabase));
    const runtime = new ComputerService({
        services: {
            credentials,
            connections,
            relay: (computerId: string) => new ComputerRelayActor({ config: { computerId }, gateways: { peers } }),
        },
        gateways: { peers },
        utilities: cx.utilities,
    });
    return {
        doDatabase: cx.doDatabase,
        gateways: { ...cx.gateways, peers, requests },
        utilities: cx.utilities,
        services: {
            ...cx.services,
            credentials,
            connections,
            runtime,
        },
    };
}
