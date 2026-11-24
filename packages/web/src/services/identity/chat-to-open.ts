import { isIdentifier, type NativeSessionTarget } from "@portalcrew/morty-client/protocol";

// Not "harness" and "sessionId": on a continuation link those name an Agent session to resume.
const harnessParameter = "openHarness";
const sessionIdParameter = "openSession";

/** A continuation link that, once redeemed, opens `chat` instead of Morty home. */
export function withChatToOpen(link: string, chat: NativeSessionTarget | null): string {
    const url = new URL(link);
    if (chat !== null) {
        url.searchParams.set(harnessParameter, chat.harness);
        url.searchParams.set(sessionIdParameter, chat.sessionId);
    }
    return url.toString();
}

export function chatToOpen(search: string): NativeSessionTarget | null {
    const query = new URLSearchParams(search);
    const harness = query.get(harnessParameter);
    const sessionId = query.get(sessionIdParameter);
    return harness !== null && isIdentifier(harness) && sessionId !== null && isIdentifier(sessionId)
        ? { harness, sessionId }
        : null;
}
