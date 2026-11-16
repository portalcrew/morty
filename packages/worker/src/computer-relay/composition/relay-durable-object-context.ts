import type { ComputerAccessService } from "../components/management/service/computer-access-service.ts";
import { CloudflareRelayPeers } from "../components/runtime/gateway/cloudflare-relay-peers.ts";
import { createRuntimeContext } from "../components/runtime/runtime-context.ts";
import type { DurableObjectDatabase } from "../infra/durable-object-database.ts";

export function createRelayDurableObjectContext(
    state: DurableObjectState,
    storage: {
        readonly database: DurableObjectDatabase;
        readonly access: (computerId: string) => ComputerAccessService;
    },
) {
    return createRuntimeContext({
        services: { access: storage.access },
        gateways: { peers: new CloudflareRelayPeers(state) },
        utilities: { waitUntil: (operation) => state.waitUntil(operation) },
        doDatabase: storage.database,
    });
}
