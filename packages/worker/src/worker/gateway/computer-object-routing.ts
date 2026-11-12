import * as v from "valibot";
import { type CloudBindings, durableObjectNamespaceBindingSchema } from "../../contracts/cloud-bindings.ts";
import { computerObjectName, decodeComputerPlacement } from "../../contracts/computer-id.ts";
import { ComputerManagementError } from "../../contracts/computer-management.ts";
import { logger } from "../../infra/logger.ts";

/** HTTP requests and WebSocket upgrades use the same computer forwarding boundary. */
export async function forwardToComputer(
    request: Request,
    bindings: CloudBindings,
    computerId: string,
): Promise<Response> {
    const stub = computerObject(bindings, computerId);
    request.signal.throwIfAborted();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 120_000);
    const signal = AbortSignal.any([request.signal, deadline.signal]);
    try {
        const body = request.body === null ? null : await request.arrayBuffer();
        signal.throwIfAborted();
        return await stub.fetch(
            new Request(request.url, {
                body,
                headers: request.headers,
                method: request.method,
                signal,
            }),
        );
    } catch (cause) {
        request.signal.throwIfAborted();
        logger.error(
            {
                event: "computer_relay_request_failed",
                durableObjectClass: "ComputerRelay",
                durableObjectId: stub.id.toString(),
                computerId,
                cfRay: request.headers.get("cf-ray")?.slice(0, 128) ?? null,
                method: request.method,
                path: new URL(request.url).pathname,
                err: cause,
            },
            "Computer request failed",
        );
        throw new ComputerManagementError(
            deadline.signal.aborted ? "COMPUTER_OBJECT_TIMEOUT" : "COMPUTER_OBJECT_UNAVAILABLE",
            "Morty storage is unavailable.",
            deadline.signal.aborted ? 504 : 503,
            { cause },
        );
    } finally {
        clearTimeout(timer);
    }
}

export function computerObject(bindings: CloudBindings, computerId: string) {
    const parsed = v.safeParse(durableObjectNamespaceBindingSchema(), bindings.COMPUTER_RELAY);
    if (!parsed.success) {
        throw new ComputerManagementError("COMPUTER_OBJECT_UNAVAILABLE", "Morty storage is unavailable.", 503);
    }
    const placement = decodeComputerPlacement(computerId);
    if (placement === null) {
        throw new ComputerManagementError("INVALID_ACCOUNT_ID", "The Computer ID is invalid.", 400);
    }
    const namespace = parsed.output;
    return namespace.get(namespace.idFromName(computerObjectName(computerId)), {
        locationHint: placement.locationHint,
    });
}
