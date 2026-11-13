import { Hono } from "hono";
import type { RelayAuthenticationConfiguration } from "../../worker/src/contracts/relay/computer-management.ts";
import type { RelayBindings } from "../../worker/src/contracts/relay-bindings.ts";
import { rethrowHonoError } from "../../worker/src/http/error-middleware.ts";
import application from "../../worker/src/index.ts";

/** All protocol tests enter the single production application with real Cloudflare bindings. */
export function createTestMortyRelayApp(options: RelayAuthenticationConfiguration): Hono<{ Bindings: RelayBindings }> {
    const testApplication = new Hono<{ Bindings: RelayBindings }>().onError(rethrowHonoError).all("*", (context) =>
        application.fetch(context.req.raw, {
            ...context.env,
            MORTY_ALLOWED_ORIGINS: JSON.stringify([...options.allowedOrigins]),
        }),
    );
    return testApplication;
}
