import { LoaderCircle, LogOut, type LucideIcon, MonitorSmartphone, UserRound, Wifi } from "lucide-react";
import { DropdownMenu, Tooltip } from "radix-ui";
import type { ReactNode } from "react";
import { dataTestId } from "../../data-testid.ts";
import { cn } from "../../lib/utils.ts";
import { Button } from "../ui/cloud-button.tsx";
import { MortyTooltipContent } from "../ui/morty-tooltip-content.tsx";
import { MortyTooltipTrigger } from "../ui/morty-tooltip-trigger.tsx";
import {
    type OverlayContentOpenAutoFocus,
    overlayMenuSeparatorClassName,
    overlaySurfacePanelClassName,
    overlaySurfaceRadiusClassName,
    overlayTriggerOffsetPx,
    preventOverlayOpenAutoFocus,
} from "../ui/overlay-surface.ts";

export function SidebarUserMenu({
    header,
    disabled,
    endAccessDisabled,
    onMeasureNetwork,
    onOpenDevices,
    onEndAccess,
    install,
}: {
    readonly header: ReactNode;
    readonly disabled: boolean;
    readonly endAccessDisabled: boolean;
    readonly onMeasureNetwork: () => void;
    readonly onOpenDevices: () => void;
    readonly onEndAccess: () => void;
    readonly install: {
        readonly busy: boolean;
        readonly start: () => void;
        readonly icon: LucideIcon;
        readonly label: string;
    } | null;
}) {
    return (
        <DropdownMenu.Root>
            <Tooltip.Root>
                <MortyTooltipTrigger asChild>
                    <DropdownMenu.Trigger asChild>
                        <Button
                            aria-label="User menu"
                            className="ml-1 shrink-0 rounded-full border-[1px] border-white bg-black/[0.08] text-copy-secondary hover:bg-black/[0.12] active:bg-black/[0.16] data-[state=open]:bg-black/[0.16]"
                            data-testid={dataTestId.userMenu}
                            disabled={disabled}
                            size="icon"
                            variant="ghost"
                        >
                            {disabled ? (
                                <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                            ) : (
                                <UserRound aria-hidden="true" className="size-4" />
                            )}
                        </Button>
                    </DropdownMenu.Trigger>
                </MortyTooltipTrigger>
                <Tooltip.Portal>
                    <MortyTooltipContent side="top" sideOffset={6}>
                        User menu
                        <Tooltip.Arrow className="fill-foreground" />
                    </MortyTooltipContent>
                </Tooltip.Portal>
            </Tooltip.Root>
            <DropdownMenu.Portal>
                <DropdownMenu.Content
                    align="start"
                    {...({
                        onOpenAutoFocus: preventOverlayOpenAutoFocus,
                    } satisfies OverlayContentOpenAutoFocus)}
                    className={cn(
                        "z-[110] min-w-[280px] animate-cloud-enter p-1.5 text-sm text-foreground outline-none motion-reduce:animate-none",
                        overlaySurfacePanelClassName,
                        overlaySurfaceRadiusClassName,
                    )}
                    side="top"
                    sideOffset={overlayTriggerOffsetPx}
                >
                    {header}
                    <DropdownMenu.Item
                        className="flex h-9 cursor-pointer items-center gap-2 rounded-full px-3 outline-none data-[highlighted]:bg-accent"
                        onSelect={onOpenDevices}
                    >
                        <MonitorSmartphone aria-hidden="true" className="size-4" />
                        Devices
                    </DropdownMenu.Item>
                    {install !== null ? (
                        <DropdownMenu.Item
                            className="flex h-9 cursor-pointer items-center gap-2 rounded-full px-3 outline-none data-[highlighted]:bg-accent data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50"
                            disabled={install.busy}
                            onSelect={install.start}
                        >
                            <install.icon aria-hidden="true" className="size-4" />
                            {install.label}
                        </DropdownMenu.Item>
                    ) : null}
                    <DropdownMenu.Separator className={cn("-mx-1.5 my-1.5", overlayMenuSeparatorClassName)} />
                    <DropdownMenu.Item
                        className="flex h-9 cursor-pointer items-center gap-2 rounded-full px-3 outline-none data-[highlighted]:bg-accent"
                        onSelect={onMeasureNetwork}
                    >
                        <Wifi aria-hidden="true" className="size-4" />
                        Network latency
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator className={cn("-mx-1.5 my-1.5", overlayMenuSeparatorClassName)} />
                    <DropdownMenu.Item
                        className="flex h-9 cursor-pointer items-center gap-2 rounded-full px-3 outline-none data-[highlighted]:bg-accent"
                        data-testid={dataTestId.endRemoteAccess}
                        disabled={endAccessDisabled}
                        onSelect={onEndAccess}
                    >
                        <LogOut aria-hidden="true" className="size-4" />
                        End current access
                    </DropdownMenu.Item>
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    );
}
