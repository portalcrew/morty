import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils.ts";
import { ExternalLink } from "../ui/external-link.tsx";

export function SetupResourceLinks({ links }: { readonly links: readonly (readonly [string, string])[] }) {
    const listRef = useRef<HTMLUListElement>(null);
    const [separatorIndices, setSeparatorIndices] = useState<readonly number[]>([]);

    useEffect(() => {
        const list = listRef.current;
        if (list === null) {
            return;
        }
        const update = () => {
            const items = Array.from(list.children);
            const indices = items.flatMap((item, index) => {
                const next = items[index + 1];
                return next !== undefined && item.getBoundingClientRect().top === next.getBoundingClientRect().top
                    ? [index]
                    : [];
            });
            setSeparatorIndices((previous) =>
                previous.length === indices.length && previous.every((value, index) => value === indices[index])
                    ? previous
                    : indices,
            );
        };
        const observer = new ResizeObserver(update);
        observer.observe(list);
        for (const [index] of links.entries()) {
            const item = list.children[index];
            if (item !== undefined) {
                observer.observe(item);
            }
        }
        update();
        return () => observer.disconnect();
    }, [links]);

    return (
        <ul className="-mx-4 flex flex-wrap items-center justify-center gap-y-1 text-xs leading-5" ref={listRef}>
            {links.map(([label, href], index) => (
                <li className="relative flex items-center px-4" key={label}>
                    <ExternalLink className="text-morty-text-3 hover:text-morty-text-2" href={href}>
                        {label}
                    </ExternalLink>
                    {index < links.length - 1 && (
                        <span
                            aria-hidden="true"
                            className={cn(
                                "absolute top-1/2 right-0 h-2 w-[0.5px] -translate-y-1/2 bg-morty-text-4",
                                !separatorIndices.includes(index) && "invisible",
                            )}
                        />
                    )}
                </li>
            ))}
        </ul>
    );
}
