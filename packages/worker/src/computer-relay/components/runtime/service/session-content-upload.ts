import type { NativeSessionTarget } from "@morty-build/client/protocol";
import { toHttpError } from "../../../../contracts/http-error.ts";
import { PairingDirectoryError } from "../../../../contracts/relay/pairing.ts";
import type { LocalSessionOperations } from "./local-session-operations.ts";
import type { SessionAccessService } from "./session-access-service.ts";

export type SessionContentUploadTarget = {
    readonly computerId: string;
    readonly target: NativeSessionTarget;
    readonly contentKey: string;
};

export const sessionContentUploadRequired = (): Response =>
    Response.json(
        { error: { code: "invalid_target", message: "A Session content upload is required" } },
        { status: 400 },
    );

/** Shared by transport admission and execution; the owning router resolves the target. */
export async function authorizeSessionContentUpload(
    request: Request,
    sessions: SessionAccessService,
    { computerId, target, contentKey }: SessionContentUploadTarget,
) {
    if (!/^[a-f0-9]{64}$/u.test(contentKey)) {
        return sessionContentUploadRequired();
    }
    const credential = (request.headers.get("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
    if (credential === undefined) {
        return Response.json(
            { error: { code: "session_access_required", message: "A Session credential is required" } },
            { status: 401 },
        );
    }
    try {
        const access = await sessions.authorizeSession(
            {
                kind: "session",
                computerId,
                target,
            },
            credential,
            request.signal,
        );
        return { access, target, contentKey };
    } catch (cause) {
        request.signal.throwIfAborted();
        const error = toHttpError(cause);
        return Response.json(error.body, { status: error.status });
    }
}

export async function uploadSessionContent(
    request: Request,
    dependencies: {
        readonly sessions: SessionAccessService;
        readonly operations: LocalSessionOperations;
    },
    location: SessionContentUploadTarget,
): Promise<Response> {
    const authorized = await authorizeSessionContentUpload(request, dependencies.sessions, location);
    if (authorized instanceof Response) {
        return authorized;
    }
    const { access, target } = authorized;
    if (request.body === null) {
        throw new PairingDirectoryError("invalid_request", "The content body is required");
    }
    const available = await dependencies.operations.writeSessionContent(
        access.computerId,
        target,
        request.body,
        request.signal,
    );
    return new Response(available, {
        headers: { "cache-control": "no-store", "content-type": "application/json" },
    });
}
