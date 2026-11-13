import { ManagementError } from "../../../../contracts/management-error.ts";
import { relayBindings } from "../../../../contracts/relay-bindings.ts";
import type { ApplicationContext } from "../../../composition/application-context.ts";
import { ComputerRelayGateway } from "../../../gateway/computer-relay.ts";

export async function replaceComputer(
    application: ApplicationContext,
    localToken: string,
    setupRunId: string | null,
    signal: AbortSignal,
): Promise<Response> {
    const { authentication, management } = application.services;
    const audit = {
        event: "computer_replacement",
        previousComputerId: application.identity.computerId,
        setupRunId,
    };
    application.logger.info({ ...audit, stage: "requested" }, "Computer replacement requested");
    try {
        const successor = await management.replaceComputer(application.identity.computerId, signal);
        // Repeating the same saved local identity reuses its successor credential, even if bootstrap
        // committed only part of its data. An explicitly revoked successor credential is never reissued.
        const response = await new ComputerRelayGateway(
            relayBindings(application.config.bindings),
            successor.computerId,
        ).bootstrap(
            new Request("https://computer.internal/__computer/bootstrap", {
                body: JSON.stringify({
                    computer: successor,
                    origin: {
                        kind: "replacement",
                        previousComputerId: audit.previousComputerId,
                        token: localToken,
                    },
                }),
                headers: { "content-type": "application/json" },
                method: "POST",
                signal,
            }),
        );
        signal.throwIfAborted();
        if (!response.ok) {
            application.logger.warn(
                {
                    ...audit,
                    computerId: successor.computerId,
                    stage: "bootstrap_failed",
                    status: response.status,
                },
                "Computer replacement did not reach access revocation",
            );
            return response;
        }
        // Keep the local identity until setup has saved the successor, so a lost reply can be retried.
        const revoked = await authentication.revokeOtherAccess(localToken, signal);
        if (revoked.kind !== "revoked") {
            throw new ManagementError("UNAUTHENTICATED", "Local identity is no longer available.", 401);
        }
        application.logger.info(
            { ...audit, computerId: successor.computerId, stage: "access_revoked" },
            "Earlier shared access revoked by Computer replacement",
        );
        return response;
    } catch (cause) {
        // Do not log request bodies, credentials, or arbitrary remote error messages. A failed response
        // cannot prove whether a request already changed access, so leave the outcome unconfirmed.
        application.logger.warn(
            { ...audit, stage: "outcome_unconfirmed" },
            "Computer replacement did not return a confirmed result",
        );
        throw cause;
    }
}
