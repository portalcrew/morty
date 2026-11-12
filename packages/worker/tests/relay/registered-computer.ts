import { runInDurableObject } from "cloudflare:test";
import { ComputerAccessService } from "../../src/computer-relay/components/management/service/computer-access-service.ts";
import { ComputerRelayStore } from "../../src/computer-relay/components/management/storage/computer-relay-store.ts";
import { DurableComputerAccount } from "../../src/computer-relay/components/management/storage/durable-computer-account.ts";
import { IdentityStorage } from "../../src/computer-relay/components/management/storage/identity-storage.ts";
import { createRelayDurableObjectContext } from "../../src/computer-relay/composition/relay-durable-object-context.ts";
import { DurableObjectDatabase } from "../../src/computer-relay/infra/durable-object-database.ts";
import { computerObjectName } from "../../src/contracts/computer-id.ts";
import type { RelayBindings } from "../../src/contracts/relay-bindings.ts";

/** The computer's store and access as its ComputerRelay composes them over the object's storage. */
export function computerAccess(computerId: string, storage: DurableObjectStorage) {
    const database = new DurableObjectDatabase(storage);
    const store = new ComputerRelayStore(computerId, database);
    return {
        store,
        access: new ComputerAccessService(
            computerId,
            store,
            new DurableComputerAccount(storage),
            new IdentityStorage(database, computerId),
        ),
    };
}

/** Seeds a committed revocation through the production store and applies it to the object's real connections. */
export async function revokeTestComputer(bindings: RelayBindings, computerId: string, signal: AbortSignal) {
    await runInDurableObject(
        bindings.COMPUTER_RELAY.getByName(computerObjectName(computerId)),
        async (_instance, state) => {
            const { store, access } = computerAccess(computerId, state.storage);
            await store.revokeComputer(Date.now(), signal);
            const runtime = createRelayDurableObjectContext(state, {
                database: new DurableObjectDatabase(state.storage),
                access: () => access,
            });
            await runtime.services.runtime.revokeComputer(computerId, signal);
        },
    );
}
