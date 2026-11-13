// Modified for Morty.
// Part of the Claude ACP adapter derived from Zed Industries' claude-code-acp (Apache-2.0).

import { type ListSessionsOptions, listSessions, type SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { withDeadline, withEnvironment } from "./utils.js";

const SESSION_LIST_TIMEOUT_MILLISECONDS = 30_000;

/**
 * List the sessions on record for a project directory, or for every project when
 * `cwd` is omitted, under `environment`.
 *
 * The SDK is called in-process rather than resolved to a module URL and loaded
 * inside a worker: when this Agent is bundled into a single CJS entry there is
 * no installable package left on disk for a worker to import, so a dynamic
 * `import(specifier)` cannot resolve it. The environment the worker used to carry
 * is applied by {@link withEnvironment} instead.
 */
export function listEnvironmentSessions(
    environment: Readonly<NodeJS.ProcessEnv>,
    cwd: string | undefined,
    signal: AbortSignal,
): Promise<readonly SDKSessionInfo[]> {
    const options: ListSessionsOptions = cwd === undefined ? {} : { dir: cwd };
    return withEnvironment(environment, () =>
        withDeadline(signal, SESSION_LIST_TIMEOUT_MILLISECONDS, () => listSessions(options)),
    );
}
