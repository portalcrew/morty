import { Hono } from "hono";
import type { CloudBindings } from "../../../../contracts/cloud-bindings.ts";
import { computerCreationRequest } from "../../../../contracts/computer-creation.ts";
import { accountComputerId } from "../../../../contracts/computer-id.ts";
import { controlBodyLimit } from "../../../../http/control-body-limit.ts";
import { RequestDeadline } from "../../../../http/request-deadline.ts";
import { admitAnonymousCreation } from "../../../gateway/anonymous-creation-admission.ts";
import { computerObject } from "../../../gateway/computer-object-routing.ts";

export function createComputerCreationRoutes() {
    return new Hono<{
        readonly Bindings: CloudBindings;
    }>().post("/computers", controlBodyLimit, async (context) => {
        const request = context.req.raw;
        using deadline = new RequestDeadline(request.signal, 45_000);
        const signal = deadline.signal;
        await admitAnonymousCreation(request, context.env);
        signal.throwIfAborted();
        const computerId = await accountComputerId(crypto.randomUUID());
        signal.throwIfAborted();
        const response = await computerObject(context.env, computerId).fetch(
            computerCreationRequest(computerId, { kind: "created" }, signal),
        );
        signal.throwIfAborted();
        return response;
    });
}
