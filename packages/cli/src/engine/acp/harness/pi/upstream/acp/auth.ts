import type { AuthMethod } from "@agentclientprotocol/sdk/unstable";

export const PI_SETUP_METHOD_ID = "pi_terminal_login";

/**
 * Zed (and some other clients) currently support "Terminal Auth" via an extension field
 * in AuthMethod._meta, rather than the RFD "type/args/env" shape.
 *
 * We include BOTH for maximum compatibility:
 *  - `_meta["terminal-auth"]`: used by Zed to render the "Authenticate" banner + button.
 *  - `type/args/env`: registry-required shape.
 */
export function getAuthMethods(opts: { command?: string; supportsTerminalAuthMeta?: boolean } = {}): AuthMethod[] {
    const supportsTerminalAuthMeta = opts?.supportsTerminalAuthMeta ?? true;

    const method: any = {
        id: PI_SETUP_METHOD_ID,
        name: "Launch pi in the terminal",
        description: "Start pi in an interactive terminal to configure API keys or login",

        type: "terminal",
        args: ["--terminal-login"],
        env: {},
    };

    if (supportsTerminalAuthMeta) {
        // Best-effort launch spec for Zed's terminal-auth banner.
        // Zed expects a full command+args (see mistral-vibe implementation).
        method._meta = {
            ...(method._meta ?? {}),
            "terminal-auth": {
                args: [],
                command: opts.command ?? "pi",
                label: "Launch pi",
            },
        };
    }

    return [method as AuthMethod];
}
