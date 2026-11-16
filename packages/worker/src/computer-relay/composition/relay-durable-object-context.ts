import type { ComputerAccessService } from "../components/management/service/computer-access-service.ts";
import { CloudflareRelayPeers } from "../components/runtime/gateway/cloudflare-relay-peers.ts";
import { createRuntimeContext } from "../components/runtime/runtime-context.ts";
import type { DurableObjectDatabase } from "../infra/durable-object-database.ts";

export function createRelayDurableObjectContext(
    state: DurableObjectState,
    storage: {
        readonly computerId: string;
        readonly database: DurableObjectDatabase;
        readonly access: () => ComputerAccessService;
    },
) {
    return createRuntimeContext({
        computerId: storage.computerId,
        services: { access: storage.access },
        gateways: { peers: new CloudflareRelayPeers(state, storage.computerId) },
        utilities: { waitUntil: (operation) => state.waitUntil(operation) },
        doDatabase: storage.database,
    });
}
