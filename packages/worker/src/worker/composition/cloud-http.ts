import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { CloudBindings } from "../../contracts/cloud-bindings.ts";
import { ManagementError } from "../../contracts/management-error.ts";
import { createComputerCreationRoutes } from "../components/management/http/computer-creation-routes.ts";
import { accountProvisioner } from "../gateway/account-provisioning.ts";

const unauthenticated = () => {
    throw new ManagementError("UNAUTHENTICATED", "Computer access is required.", 401);
};

/** Worker-level requests are routed before any computer-scoped services are constructed. */
export const cloudRoutes = new Hono<{
    readonly Bindings: CloudBindings;
}>()
    .route("/v1", createComputerCreationRoutes({ services: { accounts: accountProvisioner } }))
    .all("/session", bodyLimit({ maxSize: 3 * 1_024 * 1_024 }), unauthenticated);
