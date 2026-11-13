// Modified for Morty.
// Part of the Claude ACP adapter derived from Zed Industries' claude-code-acp (Apache-2.0).

import { forkSession } from "@anthropic-ai/claude-agent-sdk";
import { withDeadline, withEnvironment } from "./utils.js";

const SESSION_FORK_TIMEOUT_MILLISECONDS = 30_000;

/**
 * Fork a session into a new branch under `environment` and return the new session id.
 *
 * The SDK is called in-process rather than resolved to a module URL and loaded
 * inside a worker: when this Agent is bundled into a single CJS entry there is
 * no installable package left on disk for a worker to import, so a dynamic
 * `import(specifier)` cannot resolve it. The environment the worker used to carry
 * is applied by {@link withEnvironment} instead.
 */
export function forkEnvironmentSession(
    environment: Readonly<NodeJS.ProcessEnv>,
    sessionId: string,
    cwd: string,
    signal: AbortSignal,
): Promise<string> {
    return withEnvironment(environment, async () => {
        const forked = await withDeadline(signal, SESSION_FORK_TIMEOUT_MILLISECONDS, () =>
            forkSession(sessionId, { dir: cwd }),
        );
        return forked.sessionId;
    });
}
