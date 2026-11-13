import * as v from "valibot";
import type { AccountProvisioner } from "../../contracts/account-provisioning.ts";
import type { CloudBindings } from "../../contracts/cloud-bindings.ts";
import { accountComputerId, computerObjectName } from "../../contracts/computer-id.ts";
import { computerManagementSchema } from "../../contracts/computer-management.ts";
import { computerAccountPath } from "../../contracts/computer-relay-http.ts";
import { validateIdentifier } from "../../contracts/relay/pairing.ts";
import { relayBindings } from "../../contracts/relay-bindings.ts";
import { RequestDeadline } from "../../http/request-deadline.ts";
import { DatabaseError } from "../../infra/sql-database.ts";

/** The Worker provisions accounts through the computer's HTTP boundary, never its services or storage. */
export function accountProvisioner(bindings: CloudBindings): AccountProvisioner {
    return async (reference, locationHint, signal) => {
        const computerId = await accountComputerId(validateIdentifier(reference, "client_reference"), locationHint);
        signal.throwIfAborted();
        const configured = relayBindings(bindings);
        using deadline = new RequestDeadline(signal, 15_000);
        try {
            deadline.signal.throwIfAborted();
            const stub = configured.COMPUTER_RELAY.getByName(computerObjectName(computerId), { locationHint });
            return await deadline.wait(
                (async () => {
                    const response = await stub.fetch(
                        new Request(new URL(computerAccountPath(computerId), "https://computer-relay.internal"), {
                            method: "POST",
                            signal: deadline.signal,
                        }),
                    );
                    if (response.status !== 200) {
                        await response.body?.cancel();
                        throw new DatabaseError("database_unavailable", "Computer account is unavailable");
                    }
                    const body: unknown = await response.json();
                    return v.parse(computerManagementSchema, body);
                })(),
            );
        } catch (cause) {
            signal.throwIfAborted();
            throw new DatabaseError(
                deadline.signal.aborted ? "database_timeout" : "database_unavailable",
                "Computer storage is unavailable",
                { cause },
            );
        }
    };
}
