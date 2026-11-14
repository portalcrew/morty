import type { Logger } from "pino";
import type { CloudBindings } from "../../contracts/cloud-bindings.ts";
import { logger } from "../../infra/logger.ts";
import type { ManagedSessionOperations } from "../components/chat/infra/managed-session-operations.ts";
import { ChatService } from "../components/chat/service/chat-service.ts";
import type { ComputerBackendService } from "../components/computer/service/computer-backend-service.ts";
import type { ComputerIdentity } from "../components/management/entity/computer-identity.ts";
import { AuthenticationService } from "../components/management/service/authentication-service.ts";
import type { IdentityOperations } from "../components/management/service/identity-operations.ts";
import { LocalComputerService } from "../components/management/service/local-computer-service.ts";
import { ManagementService } from "../components/management/service/management-service.ts";
import type { IdentityStorage } from "../components/management/storage/identity-storage.ts";
import { accountProvisioner } from "../gateway/computer-relay.ts";

export interface ApplicationContext {
    readonly config: { readonly bindings: CloudBindings };
    readonly identity: ComputerIdentity;
    readonly logger: Logger;
    readonly storages: {
        readonly identities: IdentityStorage;
    };
    readonly services: {
        readonly computers: LocalComputerService;
        readonly authentication: AuthenticationService;
        readonly chat: ChatService;
        readonly management: ManagementService;
    };
}

export function createApplicationDependencies(local: {
    readonly bindings: CloudBindings;
    readonly computer: ComputerBackendService;
    readonly identity: ComputerIdentity;
    readonly identities: IdentityStorage;
    readonly sessionOperations: ManagedSessionOperations;
    readonly identityOperations: IdentityOperations;
}): ApplicationContext {
    const cx = {
        config: { bindings: local.bindings },
        identity: local.identity,
        identityOperations: local.identityOperations,
        sessionOperations: local.sessionOperations,
        storages: { identities: local.identities },
        logger,
    };
    const authentication = new AuthenticationService(cx);
    const computers = new LocalComputerService(local.bindings.APP_ORIGIN, local.computer);
    const services = Object.freeze({
        computers,
        authentication,
        chat: new ChatService({ ...cx, services: { computers } }),
        management: new ManagementService({
            ...cx,
            services: { authentication, computers, provisionAccount: accountProvisioner(local.bindings) },
        }),
    });
    return Object.freeze({ ...cx, services });
}
