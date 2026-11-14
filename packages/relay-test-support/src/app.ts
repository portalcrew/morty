import type { RelayAuthenticationConfiguration } from "../../worker/src/contracts/relay/computer-management.ts";
import type { RelayBindings } from "../../worker/src/contracts/relay-bindings.ts";
import application from "../../worker/src/index.ts";

/** All protocol tests enter the single production application with real Cloudflare bindings. */
export function createTestMortyRelayApp(options: RelayAuthenticationConfiguration) {
    const allowedOrigins = JSON.stringify([...options.allowedOrigins]);
    return {
        fetch: (request: Request, env: RelayBindings): Promise<Response> =>
            application.fetch(request, { ...env, MORTY_ALLOWED_ORIGINS: allowedOrigins }),
    };
}
