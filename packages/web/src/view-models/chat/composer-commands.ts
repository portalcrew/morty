import type { SessionCommand } from "@portalcrew/morty-client/protocol";

export function commandSuggestions(draft: string, commands: readonly SessionCommand[]): readonly SessionCommand[] {
    const typed = /^\/(\S*)$/u.exec(draft)?.[1];
    if (typed === undefined) {
        return [];
    }
    const prefix = typed.toLowerCase();
    return commands.filter((command) => command.name.toLowerCase().startsWith(prefix));
}

export function commandDraft(command: SessionCommand): string {
    return `/${command.name} `;
}
