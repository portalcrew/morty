// Modified for Morty.
// Part of the Claude ACP adapter derived from Zed Industries' claude-code-acp (Apache-2.0).

export function formatUriAsLink(uri: string): string {
    if (uri.startsWith("file://")) {
        const path = uri.slice(7);
        return `[@${path.split("/").pop() || path}](${uri})`;
    }
    if (uri.startsWith("zed://")) {
        return `[@${uri.split("/").pop() || uri}](${uri})`;
    }
    return uri;
}

export const formatContextBlock = (uri: string, text: string): string =>
    `\n<context ref="${uri}">\n${text}\n</context>`;
