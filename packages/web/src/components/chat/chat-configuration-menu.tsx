import { ArrowLeft, Check, ChevronDown, ChevronRight, Search, X } from "lucide-react";
import { Dialog, Tooltip } from "radix-ui";
import { type PointerEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { dataTestId } from "@/data-testid";
import { cn } from "@/lib/utils";
import { MortyTooltipContent } from "../ui/morty-tooltip-content.tsx";
import {
    agentConfigurationPopoverWidthClassName,
    overlaySurfacePanelClassName,
    overlaySurfaceRadiusClassName,
    overlayTriggerOffsetPx,
    preventOverlayOpenAutoFocus,
} from "../ui/overlay-surface.ts";
import { Popover } from "../ui/popover.tsx";
import { Spinner } from "../ui/spinner.tsx";
import { ScrollEdgeFade } from "../utils/scroll-edge-fade.tsx";
import { useConfigurationViewport } from "./chat-configuration-viewport.ts";
import { mobileHeaderIconButtonClassName } from "./chat-header-control.ts";
import { HarnessMark } from "./harness-mark.tsx";
import { mobileSheetSurfaceClassName } from "./mobile-sheet.ts";
import { MobileSheetTitle } from "./mobile-sheet-title.tsx";

interface ChatConfigurationSelectControl {
    readonly disabled: boolean;
    readonly id: string;
    readonly kind: "select";
    readonly label: string;
    readonly locked?: boolean | undefined;
    readonly onValueChange: (value: string) => void;
    readonly options: readonly {
        readonly installed?: boolean;
        readonly label: string;
        readonly value: string;
    }[];
    readonly searchable?: boolean;
    readonly testId?: string | undefined;
    readonly value: string;
}

interface ChatConfigurationBooleanControl {
    readonly checked: boolean;
    readonly disabled: boolean;
    readonly id: string;
    readonly kind: "boolean";
    readonly label: string;
    readonly onCheckedChange: () => void;
    readonly testId?: string | undefined;
}

export type ChatConfigurationControl = ChatConfigurationSelectControl | ChatConfigurationBooleanControl;

function HarnessSelect({
    harness,
    mutedWhenDisabled = true,
}: {
    readonly harness: ChatConfigurationSelectControl;
    readonly mutedWhenDisabled?: boolean;
}) {
    return (
        <div className="flex flex-col gap-1.5">
            <span className="px-3.5 text-13 text-copy-secondary">{harness.label}</span>
            <div
                aria-label={harness.label}
                className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(88px,1fr))] gap-1.5"
                data-testid={dataTestId.agentSetting("harness")}
                role="radiogroup"
            >
                {harness.options.map((option) => {
                    const installed = option.installed !== false;
                    const selected = option.value === harness.value;
                    return (
                        // biome-ignore lint/a11y/useSemanticElements: harness cards use button styling inside a radiogroup.
                        <button
                            aria-checked={selected}
                            aria-disabled={!installed || harness.disabled}
                            aria-description={installed ? undefined : "Not installed"}
                            className={cn(
                                "flex min-h-11 w-full min-w-0 flex-col items-center justify-center gap-1 rounded-[16px] border px-2 py-2 text-center text-[13px] outline-none transition-colors keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/50 motion-reduce:transition-none disabled:cursor-not-allowed",
                                selected
                                    ? "border-foreground bg-foreground font-medium text-background hover:border-foreground hover:bg-foreground hover:text-background"
                                    : "border-border bg-background text-foreground hover:border-foreground/20 hover:bg-accent",
                                mutedWhenDisabled &&
                                    "disabled:cursor-not-allowed disabled:border-border disabled:bg-muted disabled:text-morty-text-3 disabled:opacity-100 disabled:hover:border-border disabled:hover:bg-muted",
                            )}
                            data-testid={dataTestId.sessionConfigValue(option.value)}
                            disabled={harness.disabled || !installed}
                            key={option.value}
                            onClick={() => {
                                if (!selected) {
                                    harness.onValueChange(option.value);
                                }
                            }}
                            role="radio"
                            title={installed ? option.label : `${option.label} (not installed)`}
                            type="button"
                        >
                            <HarnessMark harness={option.value} label={option.label} testId={dataTestId.harnessMark} />
                            <span className="min-w-0 break-words">{option.label}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

const SETTINGS_DATA_SKELETON_ROWS = [
    { key: "model", label: "w-12", value: "w-28" },
    { key: "reasoning", label: "w-28", value: "w-16" },
    { key: "mode", label: "w-14", value: "w-20" },
    { key: "access", label: "w-24", value: "w-24" },
] as const;

function SettingsDataSkeleton() {
    return (
        <>
            {SETTINGS_DATA_SKELETON_ROWS.map((row) => (
                <div
                    aria-hidden="true"
                    className="my-2 flex min-h-9 items-center justify-between gap-4 py-0 pr-2.5 pl-3.5"
                    key={row.key}
                >
                    <span
                        className={cn(
                            "mx-1 h-3 animate-pulse rounded-full bg-morty-fill-opacity-3 motion-reduce:animate-none",
                            row.label,
                        )}
                    />
                    <div className="flex items-center">
                        <span
                            className={cn(
                                "h-3.5 animate-pulse rounded-full bg-morty-fill-opacity-3 motion-reduce:animate-none",
                                row.value,
                            )}
                        />
                    </div>
                </div>
            ))}
        </>
    );
}

type ConfigurationPage = { readonly kind: "overview" } | { readonly kind: "picker"; readonly controlId: string };

type NestedMenuHoverHandlers = {
    readonly keepOpen: () => void;
    readonly scheduleClose: () => void;
};

type NestedMenuOpenSource = "hover" | "pointer" | "keyboard";

type NestedMenuPointerGrace = {
    readonly controlId: string;
    readonly originX: number;
    readonly originY: number;
    readonly edgeX: number;
    readonly top: number;
    readonly bottom: number;
};

function isInsideNestedMenuTriangle(grace: NestedMenuPointerGrace, x: number, y: number): boolean {
    const width = grace.edgeX - grace.originX;
    if (width === 0) {
        return false;
    }
    const progress = (x - grace.originX) / width;
    if (progress < 0 || progress > 1) {
        return false;
    }
    const top = grace.originY + (grace.top - grace.originY) * progress - 8;
    const bottom = grace.originY + (grace.bottom - grace.originY) * progress + 8;
    return y >= top && y <= bottom;
}

function SettingPicker({
    control,
    onSelect,
    id,
    nested = false,
    focusOnOpen = false,
}: {
    readonly control: ChatConfigurationSelectControl;
    readonly onSelect: (value: string) => void;
    readonly id: string;
    readonly nested?: boolean;
    readonly focusOnOpen?: boolean;
}) {
    const [search, setSearch] = useState("");
    // Filtering keeps the picker at the height it had when the user started typing: a shorter list would otherwise
    // let the menu or sheet reposition and move the search field under the user's typing.
    const [searchHeight, setSearchHeight] = useState<number | null>(null);
    const pickerRef = useRef<HTMLDivElement | null>(null);
    const listRef = useRef<HTMLElement | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const query = search.trim().toLocaleLowerCase();
    const options = control.options.filter((option) =>
        [option.label, option.value].some((value) => value.toLocaleLowerCase().includes(query)),
    );
    const selected = options.find((option) => option.value === control.value) ?? options[0];
    const focusOption = (direction: "first" | "last" | "next" | "previous") => {
        const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
        const current =
            document.activeElement instanceof HTMLButtonElement ? buttons.indexOf(document.activeElement) : -1;
        const index =
            direction === "first"
                ? 0
                : direction === "last"
                  ? buttons.length - 1
                  : direction === "next"
                    ? (current + 1) % buttons.length
                    : (current - 1 + buttons.length) % buttons.length;
        buttons[index]?.focus();
    };
    useEffect(() => {
        if (!focusOnOpen) {
            return;
        }
        const frame = requestAnimationFrame(() => {
            if (control.searchable) {
                searchInputRef.current?.focus({ preventScroll: true });
                return;
            }
            const selectedOption = listRef.current?.querySelector<HTMLButtonElement>('[role="option"][tabindex="0"]');
            (selectedOption ?? listRef.current)?.focus({ preventScroll: true });
        });
        return () => {
            cancelAnimationFrame(frame);
        };
    }, [control.searchable, focusOnOpen]);
    return (
        <div
            className="flex min-h-0 flex-col"
            ref={pickerRef}
            style={searchHeight === null ? undefined : { minHeight: searchHeight }}
        >
            {control.searchable && (
                <div className={cn("relative mb-2 shrink-0", nested ? "mx-2 mt-2" : "mx-4")}>
                    <Search
                        aria-hidden="true"
                        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-morty-text-3"
                    />
                    <input
                        aria-label="Search models"
                        autoComplete="off"
                        className="h-9 w-full rounded-lg border border-border bg-background pr-3 pl-9 text-base outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/20"
                        data-testid={dataTestId.modelSearch}
                        onChange={(event) => {
                            if (searchHeight === null && pickerRef.current !== null) {
                                setSearchHeight(pickerRef.current.offsetHeight);
                            }
                            setSearch(event.currentTarget.value);
                        }}
                        onKeyDown={(event) => {
                            if (event.key === "ArrowDown") {
                                event.preventDefault();
                                focusOption("first");
                            }
                        }}
                        placeholder="Search models…"
                        ref={searchInputRef}
                        type="search"
                        value={search}
                    />
                </div>
            )}
            <ScrollEdgeFade
                aria-label={control.label}
                className={cn(
                    "min-h-0 flex-auto px-2",
                    nested ? "pb-2" : "pb-[max(1rem,env(safe-area-inset-bottom))]",
                    nested && !control.searchable && "pt-2",
                )}
                fadeFromClassName="from-background"
                fadeToClassName="to-background/0"
                frameClassName={cn("flex min-h-0 flex-auto flex-col", control.searchable && "max-h-80")}
                id={id}
                onKeyDown={(event) => {
                    const direction =
                        event.key === "ArrowDown"
                            ? "next"
                            : event.key === "ArrowUp"
                              ? "previous"
                              : event.key === "Home"
                                ? "first"
                                : event.key === "End"
                                  ? "last"
                                  : undefined;
                    if (direction !== undefined) {
                        event.preventDefault();
                        focusOption(direction);
                    }
                }}
                role="listbox"
                scrollElementRef={(element) => {
                    listRef.current = element;
                }}
                tabIndex={-1}
            >
                {options.map((option) => (
                    <button
                        aria-selected={option.value === control.value}
                        className={cn(
                            "flex h-9 w-full items-center justify-between gap-3 rounded-full px-3 py-2 text-left text-sm outline-none hover:bg-accent keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-inset keyboard-focus:focus-visible:ring-ring/50",
                            !nested && "aria-selected:bg-accent",
                        )}
                        data-testid={dataTestId.sessionConfigValue(option.value)}
                        key={option.value}
                        onClick={() => onSelect(option.value)}
                        role="option"
                        tabIndex={option.value === selected?.value ? 0 : -1}
                        type="button"
                    >
                        <span className="min-w-0 truncate" title={option.label}>
                            {option.label}
                        </span>
                        {option.value === control.value && <Check aria-hidden="true" className="size-4 shrink-0" />}
                    </button>
                ))}
                {options.length === 0 && (
                    <p className="px-3 py-6 text-sm text-morty-text-3" role="status">
                        No models found.
                    </p>
                )}
            </ScrollEdgeFade>
        </div>
    );
}

function SettingControl({
    control,
    mutedWhenDisabled = true,
    valueLoading,
    onOpen,
    desktop,
    nestedOpen,
    onNestedOpenChange,
    nestedContent,
    assignButton,
    pickerId,
    onNestedTriggerPointerLeave,
    shouldDeferNestedHover,
}: {
    readonly control: ChatConfigurationControl;
    readonly mutedWhenDisabled?: boolean;
    readonly valueLoading: boolean;
    readonly onOpen: () => void;
    readonly desktop: boolean;
    readonly nestedOpen: boolean;
    readonly onNestedOpenChange: (open: boolean) => void;
    readonly nestedContent?:
        | ((
              close: () => void,
              hoverHandlers: NestedMenuHoverHandlers,
              focusOnOpen: boolean,
              setHovered: (hovered: boolean) => void,
          ) => ReactNode)
        | undefined;
    readonly assignButton: (node: HTMLButtonElement | null) => void;
    readonly pickerId: string;
    readonly onNestedTriggerPointerLeave: (x: number, y: number) => void;
    readonly shouldDeferNestedHover: (x: number, y: number) => boolean;
}) {
    const [focusNestedPickerOnOpen, setFocusNestedPickerOnOpen] = useState(false);
    const nestedMenuHoveredRef = useRef(false);
    const previousNestedOpenRef = useRef(nestedOpen);
    const focusFrameRef = useRef<number | null>(null);
    const pressButtonRef = useRef<HTMLButtonElement | null>(null);
    const nestedMenuOpenSourceRef = useRef<NestedMenuOpenSource | null>(null);
    const nestedMenuCloseTimerRef = useRef<number | null>(null);
    const cancelNestedMenuClose = useCallback(() => {
        if (nestedMenuCloseTimerRef.current !== null) {
            window.clearTimeout(nestedMenuCloseTimerRef.current);
            nestedMenuCloseTimerRef.current = null;
        }
    }, []);
    const closeNestedMenu = useCallback(() => {
        cancelNestedMenuClose();
        onNestedOpenChange(false);
    }, [cancelNestedMenuClose, onNestedOpenChange]);
    const scheduleNestedMenuClose = useCallback(() => {
        if (nestedMenuOpenSourceRef.current !== "hover") {
            return;
        }
        cancelNestedMenuClose();
        nestedMenuCloseTimerRef.current = window.setTimeout(closeNestedMenu, 120);
    }, [cancelNestedMenuClose, closeNestedMenu]);
    const openNestedMenu = useCallback(
        (source: NestedMenuOpenSource) => {
            cancelNestedMenuClose();
            nestedMenuOpenSourceRef.current = source;
            // Only keyboard activation moves focus into the picker. Pointer and
            // hover openers leave focus where the user clicked, so the search
            // field does not start out showing its focus ring.
            setFocusNestedPickerOnOpen(source === "keyboard");
            nestedMenuHoveredRef.current = source === "hover";
            onNestedOpenChange(true);
        },
        [cancelNestedMenuClose, onNestedOpenChange],
    );

    useEffect(() => {
        const wasOpen = previousNestedOpenRef.current;
        previousNestedOpenRef.current = nestedOpen;
        if (nestedOpen || !wasOpen) {
            return;
        }
        const source = nestedMenuOpenSourceRef.current;
        nestedMenuOpenSourceRef.current = null;
        nestedMenuHoveredRef.current = false;
        setFocusNestedPickerOnOpen(false);
        if (source !== null && source !== "hover") {
            focusFrameRef.current = requestAnimationFrame(() => pressButtonRef.current?.focus({ preventScroll: true }));
        }
    }, [nestedOpen]);
    useEffect(
        () => () => {
            if (focusFrameRef.current !== null) {
                cancelAnimationFrame(focusFrameRef.current);
            }
        },
        [],
    );
    useEffect(() => cancelNestedMenuClose, [cancelNestedMenuClose]);
    const value =
        control.kind === "select"
            ? (control.options.find((option) => option.value === control.value)?.label ?? control.value)
            : control.checked
              ? "On"
              : "Off";
    const opensNestedMenuOnHover = desktop && control.kind === "select" && nestedContent !== undefined;
    const hoverNestedMenu = (event: PointerEvent<HTMLButtonElement>) => {
        if (event.pointerType !== "mouse" || shouldDeferNestedHover(event.clientX, event.clientY)) {
            return;
        }
        if (nestedOpen) {
            cancelNestedMenuClose();
            return;
        }
        if (nestedMenuHoveredRef.current) {
            cancelNestedMenuClose();
            return;
        }
        openNestedMenu("hover");
    };
    const trigger = (
        <button
            aria-busy={valueLoading || undefined}
            {...(control.kind === "select"
                ? {
                      role: "combobox",
                      "aria-controls": nestedContent === undefined ? pickerId : `${pickerId}-${control.id}`,
                      "aria-expanded": nestedContent === undefined ? false : nestedOpen,
                      "aria-haspopup": "listbox",
                  }
                : { role: "switch", "aria-checked": control.checked })}
            aria-label={control.label}
            className={cn(
                "group my-2 flex h-9 w-full items-center justify-between gap-4 rounded-full py-0 pr-2.5 pl-3.5 text-left text-13 outline-none hover:bg-accent data-[state=open]:bg-accent keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/50 disabled:cursor-not-allowed",
                mutedWhenDisabled && "disabled:opacity-50",
            )}
            data-testid={control.testId}
            disabled={control.disabled || valueLoading}
            onClick={(event) => {
                if (control.kind !== "select") {
                    control.onCheckedChange();
                    return;
                }
                if (nestedContent === undefined) {
                    onOpen();
                    return;
                }
                // Keyboard activation uses the same focus-visible path as ArrowDown.
                if (event.detail === 0) {
                    event.preventDefault();
                    openNestedMenu("keyboard");
                    return;
                }
                // Prevent the trigger's built-in toggle from immediately closing a hover-opened submenu.
                event.preventDefault();
                openNestedMenu("pointer");
            }}
            onKeyDown={(event) => {
                if (
                    control.kind === "select" &&
                    (event.key === "Enter" || event.key === " " || event.key === "ArrowDown" || event.key === "ArrowUp")
                ) {
                    event.preventDefault();
                    if (nestedContent === undefined) {
                        onOpen();
                    } else {
                        openNestedMenu("keyboard");
                    }
                }
            }}
            onPointerEnter={opensNestedMenuOnHover ? hoverNestedMenu : undefined}
            onPointerMove={opensNestedMenuOnHover ? hoverNestedMenu : undefined}
            onPointerLeave={
                opensNestedMenuOnHover
                    ? (event) => {
                          if (event.pointerType === "mouse") {
                              onNestedTriggerPointerLeave(event.clientX, event.clientY);
                          }
                      }
                    : undefined
            }
            ref={(node) => {
                pressButtonRef.current = node;
                assignButton(node);
            }}
            type="button"
        >
            <span className="shrink-0 text-morty-text-3">{control.label}</span>
            <span className="flex min-w-0 items-center justify-end gap-2 text-right">
                {valueLoading && control.kind === "select" ? (
                    <span
                        aria-label={`Loading ${control.label}`}
                        className="h-3.5 w-20 animate-pulse rounded-full bg-morty-fill-opacity-3 motion-reduce:animate-none"
                        role="status"
                    />
                ) : (
                    <Tooltip.Provider delayDuration={150}>
                        <Tooltip.Root>
                            <Tooltip.Trigger asChild>
                                <span className="min-w-0 truncate text-copy-secondary transition-colors duration-150 group-hover:text-secondary-foreground group-active:text-foreground group-data-[state=open]:text-foreground motion-reduce:transition-none">
                                    {value}
                                </span>
                            </Tooltip.Trigger>
                            <Tooltip.Portal>
                                <MortyTooltipContent className="max-w-64 break-all leading-5" side="top" sideOffset={6}>
                                    {value}
                                    <Tooltip.Arrow className="fill-foreground" />
                                </MortyTooltipContent>
                            </Tooltip.Portal>
                        </Tooltip.Root>
                    </Tooltip.Provider>
                )}
                {control.kind === "select" ? (
                    <ChevronRight
                        aria-hidden="true"
                        className="size-3.5 shrink-0 text-morty-text-3 transition-colors duration-150 group-hover:text-foreground group-active:text-foreground group-data-[state=open]:text-foreground motion-reduce:transition-none"
                    />
                ) : (
                    <span
                        className={cn(
                            "flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors",
                            control.checked ? "bg-primary" : "bg-muted",
                        )}
                    >
                        <span
                            className={cn(
                                "flex size-5 items-center justify-center rounded-full bg-white shadow-sm transition-transform",
                                control.checked ? "translate-x-4" : "translate-x-0",
                            )}
                        >
                            {valueLoading && <Spinner className="scale-75" label={`Loading ${control.label}`} />}
                        </span>
                    </span>
                )}
            </span>
        </button>
    );
    return control.kind === "select" && nestedContent !== undefined ? (
        <Popover.Root onOpenChange={onNestedOpenChange} open={nestedOpen}>
            <Popover.Trigger asChild>{trigger}</Popover.Trigger>
            <Popover.Portal>
                {nestedContent(
                    closeNestedMenu,
                    {
                        keepOpen: cancelNestedMenuClose,
                        scheduleClose: scheduleNestedMenuClose,
                    },
                    focusNestedPickerOnOpen,
                    (pointerInside) => {
                        nestedMenuHoveredRef.current = pointerInside;
                    },
                )}
            </Popover.Portal>
        </Popover.Root>
    ) : (
        trigger
    );
}

export function ChatConfigurationMenu({
    controls,
    loadingControlId,
    notice,
    settingsLoading = false,
}: {
    readonly controls: readonly ChatConfigurationControl[];
    /** One setting's value is being written back. Other fields stay as they are. */
    readonly loadingControlId?: string;
    readonly notice?: ReactNode;
    readonly settingsLoading?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const [nestedControlId, setNestedControlId] = useState<string | null>(null);
    const nestedControlIdRef = useRef<string | null>(null);
    const viewport = useConfigurationViewport();
    const desktop = viewport.desktop;
    const [page, setPage] = useState<ConfigurationPage>({ kind: "overview" });
    const pickerId = useId();
    const buttonsRef = useRef(new Map<string, HTMLButtonElement>());
    const nestedMenuContentsRef = useRef(new Map<string, HTMLElement>());
    const nestedMenuPointerGraceRef = useRef<NestedMenuPointerGrace | null>(null);
    const restoreFocusRef = useRef<string | null>(null);
    const backRef = useRef<HTMLButtonElement | null>(null);
    const openNestedControl = useCallback((controlId: string) => {
        nestedMenuPointerGraceRef.current = null;
        nestedControlIdRef.current = controlId;
        setNestedControlId(controlId);
    }, []);
    const closeNestedControl = useCallback((controlId: string) => {
        // A submenu that is being replaced can still deliver a deferred
        // outside-pointer down after the next setting opened. Only the setting
        // that is still current may close itself.
        if (nestedControlIdRef.current !== controlId) {
            return;
        }
        nestedControlIdRef.current = null;
        nestedMenuPointerGraceRef.current = null;
        setNestedControlId(null);
    }, []);
    useEffect(() => {
        if (page.kind === "picker") {
            backRef.current?.focus();
            return;
        }
        const id = restoreFocusRef.current;
        const button = id === null ? undefined : buttonsRef.current.get(id);
        if (!settingsLoading && loadingControlId !== id && button !== undefined && !button.disabled) {
            button.focus();
            restoreFocusRef.current = null;
        }
    }, [page, loadingControlId, settingsLoading]);
    const changeOpen = (next: boolean) => {
        setOpen(next);
        if (!next) {
            nestedControlIdRef.current = null;
            nestedMenuPointerGraceRef.current = null;
            setNestedControlId(null);
            setPage({ kind: "overview" });
            restoreFocusRef.current = null;
        }
    };
    const goBack = () => {
        if (page.kind === "picker") {
            restoreFocusRef.current = page.controlId;
            setPage({ kind: "overview" });
        }
    };
    const onEscapeKeyDown = (event: KeyboardEvent) => {
        if (page.kind === "picker") {
            event.preventDefault();
            goBack();
        }
    };
    const harness = controls.find(
        (control): control is ChatConfigurationSelectControl => control.id === "harness" && control.kind === "select",
    );
    const settings = controls.filter((control) => control !== harness);
    const selectedHarness = harness?.options.find((option) => option.value === harness.value);
    const selections = settings.map((control) =>
        control.kind === "boolean"
            ? `${control.label}: ${control.checked ? "On" : "Off"}`
            : (control.options.find((option) => option.value === control.value)?.label ?? control.value),
    );
    const trigger = (
        <button
            aria-label="Configure agent"
            className="group flex h-9 min-w-0 max-w-[200px] items-center gap-1.5 rounded-lg px-3 text-[13px] text-copy-secondary outline-none transition-colors duration-150 hover:bg-accent hover:text-foreground active:bg-accent-active active:text-foreground keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/50 data-[state=open]:bg-accent-active data-[state=open]:text-foreground motion-reduce:transition-none"
            data-testid={dataTestId.agentConfiguration}
            title={selections.join(" · ")}
            type="button"
        >
            {selectedHarness !== undefined && (
                <HarnessMark
                    harness={selectedHarness.value}
                    label={selectedHarness.label}
                    testId={dataTestId.harnessTriggerMark}
                />
            )}
            <span className="min-w-0 truncate text-black">
                {selections.filter((value) => value.length > 0).join(" · ")}
            </span>
            <ChevronDown
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground transition-colors duration-150 group-hover:text-foreground group-active:text-foreground group-data-[state=open]:text-foreground motion-reduce:transition-none"
            />
        </button>
    );
    const picker =
        page.kind === "picker"
            ? settings.find(
                  (control): control is ChatConfigurationSelectControl =>
                      control.id === page.controlId && control.kind === "select",
              )
            : undefined;
    const header = (
        <header
            className={cn(
                "flex min-h-14 shrink-0 items-center gap-2 pl-4 pr-2.5",
                // On phones this panel is a sheet next to the other chat sheets: a 64px header puts
                // the 40px actions 12px from the top edge, so the side inset matches that 12px.
                // The phone sheet keeps 16px from the title to either action, so its row gap is 16px;
                // the desktop popover keeps the base 8px before its 36px close action.
                picker === undefined
                    ? "max-sm:h-16 max-sm:gap-4 max-sm:pl-5 max-sm:pr-3"
                    : "max-sm:h-16 max-sm:gap-4 max-sm:pl-3 max-sm:pr-3",
            )}
        >
            {picker !== undefined && (
                <button
                    aria-label="Back to Agent configuration"
                    className={cn(
                        "flex shrink-0 items-center justify-center rounded-lg outline-none hover:bg-accent keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/50",
                        desktop ? "size-9" : mobileHeaderIconButtonClassName,
                    )}
                    onClick={goBack}
                    ref={backRef}
                    type="button"
                >
                    <ArrowLeft aria-hidden="true" className={desktop ? "size-4" : "size-5"} />
                </button>
            )}
            {/* The phone sheet title comes from the shared component; the desktop popover keeps its inline label. */}
            {desktop ? (
                <span className="min-w-0 flex-1 px-1 text-16 font-semibold">
                    {picker?.label ?? "Agent configuration"}
                </span>
            ) : (
                <MobileSheetTitle className="min-w-0 flex-1 px-0">
                    {picker?.label ?? "Agent configuration"}
                </MobileSheetTitle>
            )}
            <button
                aria-label="Close Agent configuration"
                className={cn(
                    "flex shrink-0 items-center justify-center rounded-lg text-copy-secondary outline-none hover:bg-accent keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/50",
                    desktop ? "size-9" : mobileHeaderIconButtonClassName,
                )}
                onClick={() => changeOpen(false)}
                type="button"
            >
                <X aria-hidden="true" className={desktop ? "size-4" : "size-5"} />
            </button>
        </header>
    );
    const panelContents =
        picker !== undefined ? (
            <div className="flex min-h-0 flex-auto flex-col">
                <SettingPicker
                    control={picker}
                    id={pickerId}
                    key={picker.id}
                    onSelect={(value) => {
                        if (value !== picker.value) {
                            picker.onValueChange(value);
                        }
                        goBack();
                    }}
                />
            </div>
        ) : (
            <>
                {harness !== undefined && selectedHarness !== undefined && harness.locked === true && (
                    <div className="pb-2 pr-4 pl-5">
                        <Tooltip.Provider delayDuration={150}>
                            <Tooltip.Root>
                                <Tooltip.Trigger asChild>
                                    <h3 className="flex min-w-0 items-center gap-2 text-14 font-medium text-copy-secondary">
                                        <HarnessMark harness={selectedHarness.value} label={selectedHarness.label} />
                                        <span className="min-w-0 truncate">{selectedHarness.label}</span>
                                    </h3>
                                </Tooltip.Trigger>
                                <Tooltip.Portal>
                                    <MortyTooltipContent className="max-w-60 leading-5" side="top" sideOffset={6}>
                                        The harness cannot be changed for an existing session.
                                        <Tooltip.Arrow className="fill-foreground" />
                                    </MortyTooltipContent>
                                </Tooltip.Portal>
                            </Tooltip.Root>
                        </Tooltip.Provider>
                    </div>
                )}
                <ScrollEdgeFade
                    fadeFromClassName="from-background"
                    fadeToClassName="to-background/0"
                    frameClassName="flex min-h-0 flex-auto flex-col"
                    className={cn("flex min-h-0 flex-auto flex-col gap-2 px-2 pb-0")}
                >
                    {settingsLoading && (
                        <span className="sr-only" data-testid={dataTestId.agentSettingsLoading} role="status">
                            Loading harness settings…
                        </span>
                    )}
                    {harness !== undefined && selectedHarness !== undefined && harness.locked !== true && (
                        <HarnessSelect harness={harness} mutedWhenDisabled={!settingsLoading} />
                    )}
                    <div className="flex min-w-0 flex-col [&:has(button:hover)_button[data-state=open]:not(:hover)]:!bg-transparent">
                        {settingsLoading && settings.length === 0 ? (
                            <SettingsDataSkeleton />
                        ) : settings.length === 0 ? (
                            <p className="text-center text-xs text-muted-foreground">
                                This harness has no configurable settings.
                            </p>
                        ) : (
                            settings.map((control) => (
                                <div
                                    className="relative after:pointer-events-none after:absolute after:inset-x-3 after:bottom-0 after:border-b after:border-border/40 after:content-[''] last:after:hidden"
                                    key={control.id}
                                >
                                    <SettingControl
                                        control={control}
                                        assignButton={(node) => {
                                            if (node === null) {
                                                buttonsRef.current.delete(control.id);
                                            } else {
                                                buttonsRef.current.set(control.id, node);
                                            }
                                        }}
                                        onOpen={() => setPage({ kind: "picker", controlId: control.id })}
                                        desktop={desktop}
                                        onNestedTriggerPointerLeave={(x, y) => {
                                            if (nestedControlIdRef.current !== control.id) {
                                                return;
                                            }
                                            const content = nestedMenuContentsRef.current.get(control.id);
                                            if (content === undefined) {
                                                return;
                                            }
                                            const bounds = content.getBoundingClientRect();
                                            nestedMenuPointerGraceRef.current = {
                                                controlId: control.id,
                                                originX: x,
                                                originY: y,
                                                edgeX: content.dataset["side"] === "left" ? bounds.right : bounds.left,
                                                top: bounds.top,
                                                bottom: bounds.bottom,
                                            };
                                        }}
                                        shouldDeferNestedHover={(x, y) => {
                                            const grace = nestedMenuPointerGraceRef.current;
                                            if (grace === null || grace.controlId === control.id) {
                                                return false;
                                            }
                                            if (isInsideNestedMenuTriangle(grace, x, y)) {
                                                return true;
                                            }
                                            nestedMenuPointerGraceRef.current = null;
                                            return false;
                                        }}
                                        nestedOpen={nestedControlId === control.id}
                                        onNestedOpenChange={(next) => {
                                            if (next) {
                                                openNestedControl(control.id);
                                            } else {
                                                closeNestedControl(control.id);
                                            }
                                        }}
                                        nestedContent={
                                            desktop && control.kind === "select"
                                                ? (close, hoverHandlers, focusOnOpen, setHovered) => (
                                                      <Popover.Content
                                                          ref={(node) => {
                                                              if (node === null) {
                                                                  nestedMenuContentsRef.current.delete(control.id);
                                                              } else {
                                                                  nestedMenuContentsRef.current.set(control.id, node);
                                                              }
                                                          }}
                                                          align="start"
                                                          aria-label={`${control.label} options`}
                                                          className={cn(
                                                              "z-50 flex min-h-0 flex-col overflow-hidden",
                                                              control.searchable
                                                                  ? "max-h-[min(24rem,var(--radix-popover-content-available-height))] w-[280px]"
                                                                  : "max-h-[var(--radix-popover-content-available-height)] w-52",
                                                              overlaySurfacePanelClassName,
                                                              overlaySurfaceRadiusClassName,
                                                          )}
                                                          collisionPadding={16}
                                                          onEscapeKeyDown={(event) => {
                                                              // The submenu owns Escape: closing only it keeps
                                                              // the configuration panel open for the next setting.
                                                              event.preventDefault();
                                                              close();
                                                          }}
                                                          onCloseAutoFocus={(event) => {
                                                              // Replacing A with B unmounts A. Radix would return
                                                              // focus to A's trigger, which B then observes as an
                                                              // outside focus event and closes itself. Keep focus in
                                                              // place while another submenu is taking over.
                                                              if (nestedControlIdRef.current !== null) {
                                                                  event.preventDefault();
                                                              }
                                                          }}
                                                          onPointerDownOutside={(event) => {
                                                              const target = event.target;
                                                              if (
                                                                  target instanceof Node &&
                                                                  buttonsRef.current.get(control.id)?.contains(target)
                                                              ) {
                                                                  // The trigger's click handler owns toggling. Radix's
                                                                  // deferred outside pointer event would otherwise close
                                                                  // the submenu immediately after that click reopened it.
                                                                  event.preventDefault();
                                                              }
                                                          }}
                                                          onOpenAutoFocus={preventOverlayOpenAutoFocus}
                                                          onPointerEnter={() => {
                                                              nestedMenuPointerGraceRef.current = null;
                                                              setHovered(true);
                                                              hoverHandlers.keepOpen();
                                                          }}
                                                          onPointerLeave={() => {
                                                              setHovered(false);
                                                              if (focusOnOpen) {
                                                                  return;
                                                              }
                                                              hoverHandlers.scheduleClose();
                                                          }}
                                                          role="dialog"
                                                          // Open to the right by default. Radix flips the
                                                          // placement to the left when the remaining viewport
                                                          // space cannot fit the panel.
                                                          avoidCollisions
                                                          side="right"
                                                          sideOffset={overlayTriggerOffsetPx}
                                                      >
                                                          <SettingPicker
                                                              control={control}
                                                              focusOnOpen={focusOnOpen}
                                                              id={`${pickerId}-${control.id}`}
                                                              nested
                                                              onSelect={(value) => {
                                                                  if (value !== control.value) {
                                                                      control.onValueChange(value);
                                                                  }
                                                                  close();
                                                              }}
                                                          />
                                                      </Popover.Content>
                                                  )
                                                : undefined
                                        }
                                        pickerId={pickerId}
                                        mutedWhenDisabled={loadingControlId === undefined}
                                        valueLoading={settingsLoading || control.id === loadingControlId}
                                    />
                                </div>
                            ))
                        )}
                    </div>
                </ScrollEdgeFade>
            </>
        );
    if (!desktop) {
        return (
            <Dialog.Root onOpenChange={changeOpen} open={open}>
                <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
                <Dialog.Portal>
                    <Dialog.Overlay className="fixed inset-0 z-[120] bg-black/30 motion-safe:animate-cloud-enter" />
                    <Dialog.Content
                        aria-label="Agent configuration"
                        onEscapeKeyDown={onEscapeKeyDown}
                        style={{
                            maxHeight: `min(calc(100dvh - 1rem), ${viewport.height}px)`,
                            bottom: viewport.bottom,
                        }}
                        className={cn(
                            "fixed inset-x-0 bottom-0 z-[121] flex h-auto min-h-0 flex-col overflow-hidden rounded-t-overlay outline-none",
                            overlaySurfacePanelClassName,
                            mobileSheetSurfaceClassName,
                        )}
                    >
                        <Dialog.Title className="sr-only">Agent configuration</Dialog.Title>
                        {header}
                        {notice}
                        <Dialog.Description className="sr-only">
                            Configure the Agent used for this conversation.
                        </Dialog.Description>
                        {panelContents}
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>
        );
    }
    return (
        <Popover.Root onOpenChange={changeOpen} open={open}>
            <Popover.Trigger asChild>{trigger}</Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    align="start"
                    aria-label="Agent configuration"
                    className={cn(
                        "z-50 flex h-auto max-h-[min(calc(100dvh-2rem),var(--radix-popover-content-available-height))] min-h-0 flex-col overflow-hidden",
                        agentConfigurationPopoverWidthClassName,
                        overlaySurfacePanelClassName,
                        overlaySurfaceRadiusClassName,
                    )}
                    collisionPadding={16}
                    onEscapeKeyDown={onEscapeKeyDown}
                    role="dialog"
                    side="top"
                    sideOffset={overlayTriggerOffsetPx}
                >
                    {header}
                    {notice}
                    {panelContents}
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}
