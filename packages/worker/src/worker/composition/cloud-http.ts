import { Hono } from "hono";
import type { CloudBindings } from "../../contracts/cloud-bindings.ts";
import { ManagementError } from "../../contracts/management-error.ts";
import { controlBodyLimit } from "../../http/control-body-limit.ts";
import { createComputerCreationRoutes } from "../components/management/http/computer-creation-routes.ts";

const unauthenticated = () => {
    throw new ManagementError("UNAUTHENTICATED", "Computer access is required.", 401);
};

/** Worker-level requests are routed before any computer-scoped services are constructed. */
export const cloudRoutes = new Hono<{
    readonly Bindings: CloudBindings;
}>()
    .route("/v1", createComputerCreationRoutes())
    .all("/session", controlBodyLimit, unauthenticated);
