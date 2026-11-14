import { CircleAlert, Unplug } from "lucide-react";

import { dataTestId } from "@/data-testid";
import { computerDisconnectedFailure, describePageFailure, type PageFailure } from "@/view-models/format-error";

export function SessionLoadFailure({ failure }: Readonly<{ failure: PageFailure }>) {
    const disconnected = failure.kind === "computer-disconnected";
    const copy = disconnected
        ? { title: computerDisconnectedFailure.title, content: computerDisconnectedFailure.detail }
        : describePageFailure(failure.message, "Couldn't load this chat");
    const Icon = disconnected ? Unplug : CircleAlert;

    return (
        <div
            className="grid max-w-lg justify-items-center gap-3 text-center"
            data-testid={dataTestId.sessionLoadFailure}
            role="alert"
        >
            <span
                className={
                    disconnected
                        ? "flex size-14 items-center justify-center rounded-full bg-morty-fill-opacity-2 text-morty-text-3"
                        : "flex size-14 items-center justify-center rounded-full bg-destructive/5 text-destructive"
                }
            >
                <Icon aria-hidden="true" className="size-6" />
            </span>
            <p className="text-[18px] leading-6 font-semibold tracking-[-0.025em] [overflow-wrap:anywhere]">
                {copy.title}
            </p>
            <p className="max-w-sm text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">{copy.content}</p>
        </div>
    );
}
