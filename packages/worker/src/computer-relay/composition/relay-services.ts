import type { RelayBindings } from "../../contracts/relay-bindings.ts";
import type { ComputerAccessService } from "../components/management/service/computer-access-service.ts";
import { ComputerConnectionService } from "../components/management/service/computer-connection-service.ts";
import type { IdentityOperations } from "../components/management/service/identity-operations.ts";
import { PairingDirectoryService } from "../components/management/service/pairing-directory-service.ts";
import { ComputerIdentityService } from "../components/management/service/pairing-identity-service.ts";
import { PairingService } from "../components/management/service/pairing-service.ts";
import type { ComputerRelayStore } from "../components/management/storage/computer-relay-store.ts";
import { SessionAccessSigner } from "../components/runtime/entity/session-access-credential.ts";
import type { ComputerService } from "../components/runtime/service/computer-service.ts";
import { SessionAccessService } from "../components/runtime/service/session-access-service.ts";

export function createComputerRelayServices(
    bindings: RelayBindings,
    computerId: string,
    store: ComputerRelayStore,
    runtime: ComputerService,
    access: ComputerAccessService,
    credentialKey: IdentityOperations["credentialKey"],
    computerChanged: () => void,
) {
    const sessionAccess = new SessionAccessService(
        access,
        new SessionAccessSigner(bindings.MORTY_SESSION_SIGNING_SECRET),
    );
    const pairings = new PairingDirectoryService({
        computerId,
        store,
        credentialKey,
        computerChanged,
        services: {
            identities: new ComputerIdentityService(computerId, store),
            computerAccounts: access,
        },
    });
    const context = { services: { pairings, runtime } };
    return {
        access: { sessionAccess },
        relay: {
            services: {
                pairings,
                runtime,
                computerPairings: new PairingService(context),
                computerConnections: new ComputerConnectionService(context),
            },
        },
    };
}

export type RelayContext = ReturnType<typeof createComputerRelayServices>["relay"];
