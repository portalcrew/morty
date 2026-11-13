// Modified for Morty.
// Part of the Claude ACP adapter derived from Zed Industries' claude-code-acp (Apache-2.0).

import { isTaskNotificationOrigin } from "./background-task-notifications.js";
import { getEnvironmentSessionMessages } from "./environment-session-messages.js";

/**
 * Identify the latest main-conversation message in a session's transcript under
 * `environment` that the session's own query did not write, or return an empty
 * string when there is none.
 *
 * Claude Code chains each new message to the last one its process holds in memory,
 * so a new message from another client means this query continues an earlier copy.
 * The query's own messages are excluded because the CLI may flush them after the
 * turn completes. Background task notifications are excluded too: the Claude process
 * that ran the task appends them on its own, without a prompt from any client.
 * Metadata such as titles and prompt pointers is not conversation.
 */
export async function getEnvironmentSessionRevision(
    environment: Readonly<NodeJS.ProcessEnv>,
    sessionId: string,
    ownMessageIds: ReadonlySet<string>,
    signal: AbortSignal,
): Promise<string> {
    const messages = await getEnvironmentSessionMessages(environment, sessionId, signal);
    return (
        messages.findLast(
            (message) => !ownMessageIds.has(message.uuid) && !isTaskNotificationOrigin(message.nativeOrigin),
        )?.uuid ?? ""
    );
}
