import type { SessionCommand } from "@portalcrew/morty-client/protocol";
import { useEffect, useRef } from "react";
import { cn } from "../../lib/utils.ts";
import { overlaySurfacePanelClassName, overlaySurfaceRadiusClassName } from "../ui/overlay-surface.ts";

export function composerCommandOptionId(listId: string, command: SessionCommand): string {
    return `${listId}-${command.name}`;
}

export function ComposerCommandMenu({
    active,
    commands,
    listId,
    onActivate,
    onSelect,
}: {
    readonly active: SessionCommand;
    readonly commands: readonly SessionCommand[];
    readonly listId: string;
    readonly onActivate: (command: SessionCommand) => void;
    readonly onSelect: (command: SessionCommand) => void;
}) {
    const list = useRef<HTMLDivElement>(null);
    useEffect(() => {
        list.current?.ownerDocument
            .getElementById(composerCommandOptionId(listId, active))
            ?.scrollIntoView({ block: "nearest" });
    }, [active, listId]);
    return (
        <div
            aria-label="Commands"
            className={cn(
                "absolute inset-x-3 bottom-full z-20 mb-2 flex max-h-64 flex-col overflow-y-auto p-1 sm:inset-x-0",
                overlaySurfacePanelClassName,
                overlaySurfaceRadiusClassName,
            )}
            id={listId}
            ref={list}
            role="listbox"
        >
            {commands.map((command) => (
                <button
                    aria-selected={command === active}
                    className="flex w-full min-w-0 shrink-0 flex-col items-start justify-center gap-0.5 rounded-[16px] px-3 py-2 text-left text-sm outline-none aria-selected:bg-accent max-sm:min-h-11 max-sm:[font-size:15px]"
                    id={composerCommandOptionId(listId, command)}
                    key={command.name}
                    onClick={() => onSelect(command)}
                    // The pointer and the arrow keys move one shared highlight, so Enter always picks what is shown.
                    onPointerMove={() => onActivate(command)}
                    // Keeps focus in the message box, so selecting a command never closes a software keyboard.
                    onPointerDown={(event) => event.preventDefault()}
                    role="option"
                    tabIndex={-1}
                    type="button"
                >
                    <span className="max-w-full truncate font-medium">
                        /{command.name}
                        {command.inputHint.length > 0 && (
                            <span className="ml-1.5 font-normal text-copy-secondary">{command.inputHint}</span>
                        )}
                    </span>
                    {command.description.length > 0 && (
                        <span className="max-w-full truncate text-xs text-copy-secondary">{command.description}</span>
                    )}
                </button>
            ))}
        </div>
    );
}
