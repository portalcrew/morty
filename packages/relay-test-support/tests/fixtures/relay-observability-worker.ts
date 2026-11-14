import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import { ComputerRelay as RelayComputerRelay } from "../../../worker/src/computer-relay/computer-relay.ts";
import type { ConfiguredRelayBindings } from "../../../worker/src/contracts/relay-bindings.ts";
import { errorMiddleware, rethrowHonoError } from "../../../worker/src/http/error-middleware.ts";
import relay from "../../src/worker-entry.ts";

function failure(kind: string): unknown {
    if (kind === "primitive") {
        return "Non-Error failure";
    }
    if (kind === "object") {
        return { name: "RemoteFailure", message: "Remote queue exceeded", overloaded: true, secret: "PROPERTY_CANARY" };
    }
    const cause = Object.assign(new Error("Too many requests queued for the same Durable Object"), {
        overloaded: true,
        retryable: true,
        remote: true,
        code: "ERR_OVERLOADED",
    });
    const error = new Error("Computer relay request failed", { cause });
    if (kind === "circular") {
        error.cause = error;
    }
    if (kind === "deep") {
        for (let depth = 0; depth < 12; depth += 1) {
            error.cause = new Error(`Nested failure ${depth}`, { cause: error.cause });
        }
    }
    if (kind === "getter") {
        Object.defineProperty(error, "message", {
            get: () => {
                throw new Error("Broken Error getter");
            },
        });
    }
    if (kind === "long") {
        error.message = "x".repeat(100_000);
    }
    if (kind === "secrets") {
        error.message =
            "Upstream https://user:PASSWORD_CANARY@relay.test/daemon?token=URL_CANARY failed Bearer ERROR_CANARY";
    }
    return error;
}

// The exported Cloudflare callback is the relay fault-injection boundary.
export class ComputerRelay extends RelayComputerRelay {
    override async fetch(request: Request): Promise<Response> {
        if (
            request.headers.get("x-test-computer-failure") === "1" &&
            new URL(request.url).pathname === "/morty/api/v1/computers/connect"
        ) {
            throw Object.assign(new Error("Computer DO overloaded"), { overloaded: true });
        }
        return await super.fetch(request);
    }
}

function computerOverload(): Error {
    return Object.assign(new Error("Computer DO overloaded"), { overloaded: true });
}

export class UnavailableComputer extends DurableObject {
    override fetch(): Response {
        throw computerOverload();
    }
}

interface TestBindings extends ConfiguredRelayBindings {
    // Stands in for COMPUTER_RELAY: every request and operation sent to it fails.
    readonly UNAVAILABLE_COMPUTER: DurableObjectNamespace;
}

const application = new Hono<{ Bindings: TestBindings }>()
    .use("*", errorMiddleware)
    .onError(rethrowHonoError)
    .post("/failure/:kind", (context) => {
        throw failure(context.req.param("kind"));
    });

export default {
    fetch: (request: Request, environment: TestBindings) => {
        if (new URL(request.url).pathname.startsWith("/morty/")) {
            return relay.fetch(
                request,
                request.headers.has("x-test-routing-failure")
                    ? { ...environment, COMPUTER_RELAY: environment.UNAVAILABLE_COMPUTER }
                    : environment,
            );
        }
        return application.fetch(request, environment);
    },
};
