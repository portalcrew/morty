import type { ComputerEncryptionAccess } from "@morty-build/client";
import { decodeSessionReadyEvent, type SessionConfigurationSelection } from "@morty-build/client/protocol";
import { WorkerApiTransport } from "../../packages/web/src/services/api/worker-api-transport.ts";
import { BotChatApi } from "../../packages/web/src/services/chat/bot-chat-api.ts";

/** Uses the product's owner API client against the real Worker in Computer integration scenarios. */
export function createOwnerApi(options: {
    readonly origin: string;
    readonly computerId: string;
    readonly credential: string;
    readonly request: (request: Request) => Promise<Response>;
    readonly encryptionAccess?: ComputerEncryptionAccess;
}) {
    const transport = new WorkerApiTransport(options.origin, (computerId) =>
        options.encryptionAccess?.computerId === computerId ? options.encryptionAccess : null,
    );
    const api = new BotChatApi({
        sessionTransport: () => transport.computerTransport(options.computerId),
        encryptionAccess: () => options.encryptionAccess ?? null,
        origin: options.origin,
        computerId: options.computerId,
        fetchRequest: transport.fetch,
        getToken: async (signal) => {
            signal.throwIfAborted();
            return options.credential;
        },
        waitForChange: transport.waitForChange,
    });
    return {
        api,
        createSession: async (
            input: {
                readonly harness: string;
                readonly configurations: readonly SessionConfigurationSelection[];
                readonly directory: string;
                readonly computerId: string;
                readonly operationId: string;
            },
            signal: AbortSignal,
        ) => {
            await api.verifyAgent(input.harness, signal);
            const access = await api.createConversation(
                input.operationId,
                {
                    harness: input.harness,
                    workspaceRef: input.directory,
                    workspaceLabel: input.directory,
                    configurations: input.configurations,
                },
                signal,
            );
            return decodeSessionReadyEvent(JSON.stringify(access.ready));
        },
        sessionClient: api.connectSession,
        close: () => {
            api.close();
            transport.dispose();
        },
    };
}
