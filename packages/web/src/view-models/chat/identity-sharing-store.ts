import { base64urlnopad } from "@scure/base";
import QRCode from "qrcode";
import { createStore } from "zustand/vanilla";
import {
    type AccessDurationOptions,
    type DeviceAccessDuration,
    deviceAccessDurations,
    IdentityApiError,
    type IdentityTransfer,
    type SharingTerms,
    transferCodeComputer,
} from "@/services/identity/anonymous-identity-api";
import { storedComputerEncryption } from "@/services/identity/remembered-computers";
import type { Clock } from "@/services/time/clock";
import { formatMoment } from "./access-presentation.ts";

type IdentitySharingState =
    | { readonly kind: "initial" }
    | {
          readonly kind: "loading" | "unconfirmed";
          readonly duration: DeviceAccessDuration | null;
          readonly request: SharingTerms;
      }
    | { readonly kind: "refused"; readonly duration: DeviceAccessDuration | null }
    | {
          readonly kind: "ready";
          readonly image: string;
          readonly transfer: IdentityTransfer;
          readonly replacedEarlier: boolean;
      };

export type SharingRecipient = "person" | "agent";

export interface IdentitySharingStore {
    readonly state: IdentitySharingState;
    /** Null until the Worker reports them; a Worker released before them never does. */
    readonly durationOptions: AccessDurationOptions | null;
    readonly recipient: SharingRecipient;
    readonly recipientTransitioning: boolean;
    readonly chooseRecipient: (recipient: SharingRecipient) => void;
    readonly start: (signal: AbortSignal) => void;
    readonly choose: (duration: DeviceAccessDuration) => void;
    readonly retry: () => void;
    readonly dispose: () => void;
}

const durationLabels: Readonly<Record<DeviceAccessDuration, string>> = {
    "1h": "1 hour",
    "1d": "1 day",
    "7d": "7 days",
    "30d": "30 days",
};

const untilSharerAccessEnds = "until-sharer-access-ends";
export type DurationChoiceValue = DeviceAccessDuration | typeof untilSharerAccessEnds;

interface DurationChoice {
    readonly value: DurationChoiceValue;
    readonly label: string;
    readonly hint?: string;
    readonly disabled?: boolean;
}

export interface DurationChoices {
    readonly options: readonly DurationChoice[];
    readonly selected: DurationChoiceValue | null;
    readonly sharerAccessEndsAt: string | null;
}

function selectedDuration(state: IdentitySharingState): DeviceAccessDuration | null {
    switch (state.kind) {
        case "ready":
            return state.transfer.accessDuration;
        case "loading":
        case "unconfirmed":
        case "refused":
            return state.duration;
        case "initial":
            return null;
    }
}

/**
 * A duration the sharer's own access cuts short stays listed but disabled, so the sharer sees why it is unavailable,
 * and one choice names where shared access actually ends instead.
 */
export function durationChoices(state: IdentitySharingState, options: AccessDurationOptions | null): DurationChoices {
    const duration = selectedDuration(state);
    if (options === null) {
        return {
            options: deviceAccessDurations.map((value) => ({ value, label: durationLabels[value] })),
            selected: duration,
            sharerAccessEndsAt: null,
        };
    }
    const limited = options.filter((option) => option.accessLimitedBySharer);
    // A retried operation reports the terms it committed earlier, which the options read now may no longer show.
    const sharerAccessEndsAt =
        limited[0]?.accessExpiresAt ??
        (state.kind === "ready" && state.transfer.accessLimitedBySharer ? state.transfer.accessExpiresAt : null);
    const limitedSelection =
        state.kind === "ready"
            ? state.transfer.accessLimitedBySharer
            : limited.some((option) => option.accessDuration === duration);
    const untilSharerEndsChoice: DurationChoice[] =
        sharerAccessEndsAt === null
            ? []
            : [
                  {
                      value: untilSharerAccessEnds,
                      label: "Until this browser's access ends",
                      hint: formatMoment(sharerAccessEndsAt),
                  },
              ];
    return {
        options: [
            ...options
                .filter((option) => !option.accessLimitedBySharer)
                .map(
                    (option): DurationChoice => ({
                        value: option.accessDuration,
                        label: durationLabels[option.accessDuration],
                        hint: `Until ${formatMoment(option.accessExpiresAt)}`,
                    }),
                ),
            ...untilSharerEndsChoice,
            ...limited.map(
                (option): DurationChoice => ({
                    value: option.accessDuration,
                    label: durationLabels[option.accessDuration],
                    hint: "Longer than this browser's access",
                    disabled: true,
                }),
            ),
        ],
        selected: duration === null ? null : limitedSelection ? untilSharerAccessEnds : duration,
        sharerAccessEndsAt,
    };
}

/** Any duration the sharer's access cuts short grants the same term, so the shortest of them stands for that choice. */
export function chosenDuration(
    value: DurationChoiceValue,
    options: AccessDurationOptions | null,
): DeviceAccessDuration | null {
    if (value !== untilSharerAccessEnds) {
        return value;
    }
    return options?.find((option) => option.accessLimitedBySharer)?.accessDuration ?? null;
}

function linkCode(transfer: IdentityTransfer): string {
    return new URLSearchParams(new URL(transfer.url).hash.slice(1)).get("code") ?? "";
}

async function transferQrImage(url: string): Promise<string> {
    const options = { errorCorrectionLevel: "H" as const, margin: 2, width: 320 };
    try {
        const canvas = document.createElement("canvas");
        await QRCode.toCanvas(canvas, url, options);
        const context = canvas.getContext("2d");
        if (context === null) {
            throw new Error("QR canvas is unavailable.");
        }
        const logo = new Image();
        logo.src = "/morty-logo.svg";
        await logo.decode();
        const badgeSize = Math.round(canvas.width * 0.16);
        const logoSize = Math.round(badgeSize * 0.88);
        const badgeStart = (canvas.width - badgeSize) / 2;
        const logoStart = (canvas.width - logoSize) / 2;
        context.fillStyle = "#fff";
        context.beginPath();
        context.roundRect(badgeStart, badgeStart, badgeSize, badgeSize, Math.round(badgeSize * 0.22));
        context.fill();
        context.drawImage(logo, logoStart, logoStart, logoSize, logoSize);
        return canvas.toDataURL("image/png");
    } catch {
        return QRCode.toDataURL(url, options);
    }
}

export const createIdentitySharingStore = (
    createTransfer: (terms: SharingTerms, signal: AbortSignal) => Promise<IdentityTransfer>,
    sharingTerms: (signal: AbortSignal) => Promise<AccessDurationOptions>,
    clock: Clock,
) => {
    const lifetime = new AbortController();
    let signal = lifetime.signal;
    let recipientTransition: AbortController | null = null;
    const store = createStore<IdentitySharingStore>(() => ({
        start: (parent) => {
            if (store.getState().state.kind !== "initial" || lifetime.signal.aborted) {
                return;
            }
            signal = AbortSignal.any([parent, lifetime.signal]);
            issue({ operationId: crypto.randomUUID(), accessDuration: null, replaces: null }, null);
        },
        choose: (duration) => {
            if (signal.aborted) {
                return;
            }
            const state = store.getState().state;
            switch (state.kind) {
                case "initial":
                case "refused":
                    return;
                case "loading":
                    // The selected term may change; the already issued operation keeps its original meaning.
                    store.setState({ state: { ...state, duration } });
                    return;
                case "unconfirmed":
                    issue(state.request, duration);
                    return;
                case "ready":
                    issue(
                        {
                            operationId: crypto.randomUUID(),
                            accessDuration: duration,
                            replaces: linkCode(state.transfer),
                        },
                        duration,
                    );
                    return;
            }
        },
        retry: () => {
            const state = store.getState().state;
            if (state.kind === "unconfirmed") {
                issue(state.request, state.duration);
            }
        },
        dispose: () => {
            recipientTransition?.abort();
            lifetime.abort(new Error("Identity sharing closed."));
        },
        // The recipient changes only how the same link is presented, so choosing one never issues another link.
        chooseRecipient: (recipient) => {
            if (lifetime.signal.aborted || store.getState().recipient === recipient) {
                return;
            }
            recipientTransition?.abort();
            const transition = new AbortController();
            recipientTransition = transition;
            store.setState({ recipient, recipientTransitioning: true });
            void clock.sleep(250, AbortSignal.any([lifetime.signal, transition.signal])).then(
                () => {
                    if (recipientTransition === transition) {
                        recipientTransition = null;
                        store.setState({ recipientTransitioning: false });
                    }
                },
                () => undefined,
            );
        },
        recipient: "person",
        recipientTransitioning: false,
        state: { kind: "initial" },
        durationOptions: null,
    }));
    let termsRead: AbortController | null = null;
    // Read again with every link, so the dates beside each duration stay current while the dialog stays open.
    const readSharingTerms = () => {
        termsRead?.abort();
        const read = new AbortController();
        termsRead = read;
        const readSignal = AbortSignal.any([signal, read.signal]);
        void sharingTerms(readSignal).then(
            (durationOptions) => {
                if (!readSignal.aborted) {
                    store.setState({ durationOptions });
                }
            },
            () => undefined,
        );
    };
    const issue = (request: SharingTerms, duration: DeviceAccessDuration | null) => {
        if (signal.aborted) {
            return;
        }
        store.setState({ state: { kind: "loading", duration, request } });
        readSharingTerms();
        void (async () => {
            try {
                const issued = await createTransfer(request, signal);
                const computerId = transferCodeComputer(linkCode(issued));
                const access = computerId === null ? null : storedComputerEncryption(computerId);
                if (access === null) {
                    throw new IdentityApiError(
                        "INVALID_REQUEST",
                        "Encrypted Computer access is required to share this Computer.",
                    );
                }
                const url = new URL(issued.url);
                const fragment = new URLSearchParams(url.hash.slice(1));
                fragment.set("e2e", base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(access))));
                url.hash = fragment.toString();
                const transfer = { ...issued, url: url.toString() };
                signal.throwIfAborted();
                const image = await transferQrImage(transfer.url);
                signal.throwIfAborted();
                const current = store.getState().state;
                if (current.kind !== "loading") {
                    return;
                }
                if (current.duration !== null && current.duration !== transfer.accessDuration) {
                    issue(
                        {
                            operationId: crypto.randomUUID(),
                            accessDuration: current.duration,
                            replaces: linkCode(transfer),
                        },
                        current.duration,
                    );
                    return;
                }
                store.setState({
                    state: { kind: "ready", image, transfer, replacedEarlier: request.replaces !== null },
                });
            } catch (cause) {
                if (signal.aborted) {
                    return;
                }
                const current = store.getState().state;
                if (current.kind !== "loading") {
                    return;
                }
                const refused =
                    cause instanceof IdentityApiError &&
                    ["TRANSFER_CONFLICT", "UNAUTHENTICATED", "INVALID_REQUEST", "CREDENTIAL_KIND_REQUIRED"].includes(
                        cause.code,
                    );
                store.setState({
                    state: refused
                        ? { kind: "refused", duration: current.duration }
                        : { kind: "unconfirmed", duration: current.duration, request },
                });
            }
        })();
    };
    return store;
};

/**
 * What the user pastes into an AI agent: where the published agent API is documented, and the link to redeem. The
 * document lives on the link's own origin, so the agent reads the description of the server that issued the link.
 */
export function agentHandoffInstructions(transfer: IdentityTransfer): string {
    const documentUrl = new URL("/doc/agent-api.md", transfer.url).toString();
    return [
        "Use Morty to work on my computer.",
        `Read ${documentUrl} first. It provides the runnable encrypted Agent workflow and links the OpenAPI and AsyncAPI contracts.`,
        "Then redeem this one-time continue link as that document describes. Keep it secret: it can view and control every session on my computer.",
        transfer.url,
    ].join("\n");
}
