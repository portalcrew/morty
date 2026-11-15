import { Hono } from "hono";
import type { CloudBindings } from "../../../../contracts/cloud-bindings.ts";
import { computerLocationHint } from "../../../../contracts/computer-location.ts";
import { controlBodyLimit } from "../../../../http/control-body-limit.ts";
import { RequestDeadline } from "../../../../http/request-deadline.ts";
import { accountProvisioner } from "../../../gateway/account-provisioning.ts";
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
        const computer = await accountProvisioner(context.env)(
            crypto.randomUUID(),
            computerLocationHint(request) ?? "apac",
            signal,
        );
        const response = await computerObject(context.env, computer.computerId).fetch(
            new Request("https://computer.internal/__computer/bootstrap", {
                method: "POST",
                headers: { "content-type": "application/json" },
                signal,
                body: JSON.stringify({ computer, origin: { kind: "created" } }),
            }),
        );
        signal.throwIfAborted();
        return response;
    });
}
