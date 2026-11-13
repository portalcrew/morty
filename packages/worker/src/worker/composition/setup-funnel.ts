import type { Logger } from "pino";
import type { CloudBindings } from "../../contracts/cloud-bindings.ts";

type WorkerFetch = (request: Request, bindings: CloudBindings, context?: ExecutionContext) => Promise<Response>;

/** Who made a setup request: a person's browser, or the Agent and the Morty CLI it runs. */
type SetupClient = "browser" | "agent";

/** The setup steps a new user passes, from fetching the instructions to opening Morty through the returned link. */
const funnelSteps = [
    { event: "setup_instructions_served", method: "GET", path: /^\/doc\/setup\.md$/u },
    { event: "identity_created", method: "POST", path: /^\/morty\/api\/computers$/u },
    {
        event: "sharing_link_issued",
        method: "POST",
        path: /^\/morty\/api(?:\/computers\/[^/]+)?\/identity\/transfers$/u,
    },
    {
        event: "sharing_link_redeemed",
        method: "POST",
        path: /^\/morty\/api\/identity\/transfers\/redeem$/u,
    },
] as const;

/**
 * Records a successful setup step as one structured log line, so launch traffic can be counted step by step in
 * Workers Logs. Events carry no user, Computer, or network identifiers: only the step and who made the request.
 */
function recordSetupFunnelStep(logger: Logger, request: Request, response: Response, client: SetupClient) {
    if (!response.ok) {
        return;
    }
    const pathname = new URL(request.url).pathname;
    const step = funnelSteps.find((candidate) => candidate.method === request.method && candidate.path.test(pathname));
    if (step !== undefined) {
        logger.info({ event: step.event, client }, "Setup funnel step");
    }
}

/**
 * Records setup steps that arrive over HTTP. It wraps the whole Worker so cached instruction documents count too.
 * Browsers send `Sec-Fetch-Site` on every request, including typed navigations; Node's fetch, curl and agent tools
 * do not.
 */
export function withSetupFunnelEvents(next: WorkerFetch, logger: Logger): WorkerFetch {
    return async (request, bindings, context) => {
        const response = await next(request, bindings, context);
        recordSetupFunnelStep(logger, request, response, request.headers.has("Sec-Fetch-Site") ? "browser" : "agent");
        return response;
    };
}
