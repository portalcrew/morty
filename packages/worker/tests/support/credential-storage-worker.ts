import { ComputerRelayStore } from "../../src/computer-relay/components/management/storage/computer-relay-store.ts";
import { ComputerRelay as ProductionComputerRelay } from "../../src/computer-relay/computer-relay.ts";
import { DurableObjectDatabase } from "../../src/computer-relay/infra/durable-object-database.ts";
import type { ConfiguredRelayBindings } from "../../src/contracts/relay-bindings.ts";
import chat from "../../src/index.ts";

// The public Worker reaches the production ComputerRelay namespace.
export default {
    fetch: async (request: Request, env: ConfiguredRelayBindings) => await chat.fetch(request, env),
};

/** Seeds persisted boundary conditions while keeping authentication and revocation on the production HTTP path. */
export class ComputerRelay extends ProductionComputerRelay {
    override async fetch(request: Request): Promise<Response> {
        if (request.url === "https://computer.internal/revoked-computer" && request.method === "POST") {
            await request.body?.cancel();
            await new ComputerRelayStore(new DurableObjectDatabase(this.ctx.storage)).revokeComputer(
                Date.now(),
                request.signal,
            );
            return new Response(null, { status: 204 });
        }
        if (request.url === "https://computer.internal/aged-links" && request.method === "POST") {
            // Reconstruct links whose device term has passed: the Durable Object's clock cannot be moved forward.
            this.ctx.storage.sql.exec(
                "UPDATE identity_transfer SET created_at = created_at - (access_expires_at - created_at), expires_at = expires_at - (access_expires_at - created_at), access_expires_at = created_at",
            );
            return new Response(null, { status: 204 });
        }
        if (request.url === "https://computer.internal/stored-state") {
            // Read-only: reports what this object persisted, without opening its database.
            return Response.json({
                keys: [...(await this.ctx.storage.list()).keys()],
                tables: this.ctx.storage.sql
                    .exec<{ name: string }>(
                        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
                    )
                    .toArray()
                    .map((row) => row.name),
            });
        }
        return await super.fetch(request);
    }
}
