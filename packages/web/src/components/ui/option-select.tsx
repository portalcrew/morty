import { Check, ChevronDown } from "lucide-react";
import { Select as Primitive } from "radix-ui";
import { type ComponentProps, useId } from "react";
import { dataTestId } from "@/data-testid";
import { cn } from "@/lib/utils";
import {
    type OverlayContentOpenAutoFocus,
    overlaySurfacePanelClassName,
    overlaySurfaceRadiusClassName,
    overlayTriggerOffsetPx,
} from "./overlay-surface.ts";

const optionItemClassName =
    "relative flex cursor-default select-none items-center gap-4 rounded-full py-2 pr-4 pl-8.5 text-[13px] outline-none data-[highlighted]:bg-accent data-[disabled]:text-muted-foreground";

export function Select({
    label,
    value,
    onValueChange,
    options,
    disabled = false,
    placeholder,
    className = "",
    viewportClassName,
    description,
}: {
    readonly label: string;
    readonly value: string;
    readonly onValueChange: (value: string) => void;
    readonly options: readonly {
        readonly label: string;
        readonly title?: string;
        readonly value: string;
        readonly hint?: string;
        readonly disabled?: boolean;
    }[];
    readonly placeholder?: string;
    readonly disabled?: boolean;
    readonly className?: string;
    readonly viewportClassName?: string;
    readonly description?: string | undefined;
}) {
    const idPrefix = useId();
    const descriptionId = `${idPrefix}-description`;
    return (
        <>
            <Primitive.Root disabled={disabled} onValueChange={onValueChange} value={value}>
                <Primitive.Trigger
                    aria-describedby={description === undefined ? undefined : descriptionId}
                    aria-label={label}
                    className={cn(
                        "flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 text-left text-[13px] outline-none transition-colors hover:bg-accent disabled:opacity-50 keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/50 motion-reduce:transition-none",
                        className,
                    )}
                >
                    <span className="min-w-0 truncate">
                        <Primitive.Value placeholder={placeholder ?? `Select ${label.toLowerCase()}`} />
                    </span>
                    <Primitive.Icon className="shrink-0">
                        <ChevronDown aria-hidden="true" className="size-3.5 text-muted-foreground" />
                    </Primitive.Icon>
                </Primitive.Trigger>
                <Primitive.Portal>
                    <Primitive.Content
                        {...({
                            className: cn(
                                "z-[130] flex min-h-0 max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)] animate-cloud-enter flex-col overflow-hidden text-foreground motion-reduce:animate-none sm:z-[60]",
                                overlaySurfacePanelClassName,
                                overlaySurfaceRadiusClassName,
                            ),
                            onOpenAutoFocus: (event: Event) => {
                                event.preventDefault();
                            },
                            position: "popper",
                            sideOffset: overlayTriggerOffsetPx,
                        } satisfies ComponentProps<typeof Primitive.Content> & OverlayContentOpenAutoFocus)}
                    >
                        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                            <Primitive.Viewport
                                className={cn("h-full min-h-0 flex-1 px-2.5 pt-1 pb-2.5", viewportClassName)}
                            >
                                {options.map((option) => {
                                    const hintId = `${idPrefix}-${option.value}`;
                                    return (
                                        <Primitive.Item
                                            aria-describedby={option.hint === undefined ? undefined : hintId}
                                            className={optionItemClassName}
                                            data-testid={dataTestId.sessionConfigValue(option.value)}
                                            disabled={option.disabled === true}
                                            key={option.value}
                                            title={option.title}
                                            value={option.value}
                                        >
                                            <Primitive.ItemIndicator className="absolute top-1/2 left-2 flex -translate-y-1/2 items-center justify-center">
                                                <Check aria-hidden="true" className="ml-1 size-3.5" />
                                            </Primitive.ItemIndicator>
                                            <Primitive.ItemText>{option.label}</Primitive.ItemText>
                                            {option.hint !== undefined && (
                                                // Kept out of the option's name; it is announced as the description.
                                                <span
                                                    aria-hidden="true"
                                                    className="ml-auto text-xs text-muted-foreground"
                                                    id={hintId}
                                                >
                                                    {option.hint}
                                                </span>
                                            )}
                                        </Primitive.Item>
                                    );
                                })}
                            </Primitive.Viewport>
                        </div>
                    </Primitive.Content>
                </Primitive.Portal>
            </Primitive.Root>
            {description !== undefined && (
                <p className="text-xs leading-5 text-morty-text-3" id={descriptionId}>
                    {description}
                </p>
            )}
        </>
    );
}
