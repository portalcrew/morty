import type { NativeSessionTarget } from "@morty-build/client/protocol";
import { toHttpError } from "../../../../contracts/http-error.ts";
import type { SessionAccessService } from "../service/session-access-service.ts";

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
        const access = await sessions.authorizeSession({ computerId, target }, credential, request.signal);
        return { access, target, contentKey };
    } catch (cause) {
        request.signal.throwIfAborted();
        const error = toHttpError(cause);
        return Response.json(error.body, { status: error.status });
    }
}
