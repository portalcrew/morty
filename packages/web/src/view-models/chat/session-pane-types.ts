import type { MortyElicitationAnswer, MortyPermissionAnswer } from "@portalcrew/morty-client";
import type {
    NativeSessionTarget,
    SessionElicitationRequestedEvent,
    SessionElicitationResolvedEvent,
    SessionPermissionRequestedEvent,
} from "@portalcrew/morty-client/protocol";

type PermissionInteractionDetails = Pick<
    SessionPermissionRequestedEvent,
    "details" | "interactionId" | "options" | "target" | "title" | "toolCallId" | "toolKind"
>;

type PermissionInteractionState =
    | { readonly kind: "pending" }
    | { readonly kind: "resolved"; readonly answer: MortyPermissionAnswer };

export type PermissionInteraction = PermissionInteractionDetails & {
    readonly state: PermissionInteractionState;
};

/** An event without the fields that only place it in the log, kept distributive over a union's variants. */
type DetailsOf<Event> = Event extends unknown ? Omit<Event, "kind" | "commandId"> : never;

type ElicitationInteractionDetails = DetailsOf<SessionElicitationRequestedEvent>;

type ElicitationInteractionState =
    | { readonly kind: "pending" }
    | { readonly kind: "awaiting-completion" }
    | { readonly kind: "resolved"; readonly action: SessionElicitationResolvedEvent["action"] };

export type ElicitationInteraction = ElicitationInteractionDetails & {
    readonly state: ElicitationInteractionState;
};

export type SessionInteraction =
    | { readonly kind: "permission"; readonly permission: PermissionInteraction }
    | { readonly kind: "elicitation"; readonly elicitation: ElicitationInteraction };

export interface PermissionInteractionResponse {
    readonly answer: MortyPermissionAnswer;
    readonly interactionId: string;
    readonly target: NativeSessionTarget;
}

export interface ElicitationInteractionResponse {
    readonly answer: MortyElicitationAnswer;
    readonly interactionId: string;
    readonly target: NativeSessionTarget;
}
