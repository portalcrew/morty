import type {
    PromptAttachment,
    SessionConfigurationSelection,
    SessionElicitationFormContent,
    SessionLogPosition,
    SessionPromptAcceptedEvent,
    SessionPromptDisposition,
} from "@portalcrew/morty-client/protocol";

import { MortyValidationError } from "./errors.ts";

interface SubmitMortyTurnContent {
    readonly attachments: readonly PromptAttachment[];
    readonly content: string;
    readonly idempotencyKey: string;
    readonly sessionConfigurations?: readonly SessionConfigurationSelection[];
}

/**
 * A Turn submission. Without a disposition the message is appended: the Computer runs it now or queues it behind the
 * Session's earlier work and answers which. A steering submission joins the running Turn it names, and is refused,
 * leaving its idempotency key unused, when that Turn is not running.
 */
export type SubmitMortyTurnRequest = SubmitMortyTurnContent &
    (
        | { readonly disposition?: typeof SessionPromptDisposition.Append }
        | { readonly disposition: typeof SessionPromptDisposition.Steer; readonly targetCommandId: string }
    );

/** Where the Computer admitted a submitted command, and the Session log position at which that standing holds. */
export type MortyTurnAdmission = Pick<SessionPromptAcceptedEvent, "standing" | "position">;

/**
 * How a cancelled Turn ended: `cancelled`, or the Agent's stop reason when the Turn finished first; it holds from
 * `position` in the Session's log.
 */
export type MortyTurnCancellation = { readonly stopReason: string; readonly position: SessionLogPosition };

/** The Session log position from which a read or live event reflects a queued command's withdrawal or steering. */
export type MortyQueuedTurnChange = { readonly position: SessionLogPosition };

export type MortyPermissionAnswer =
    | { readonly outcome: "selected"; readonly optionId: string }
    | { readonly outcome: "cancelled" };

export type MortyElicitationAnswer =
    | { readonly action: "accept"; readonly content: SessionElicitationFormContent }
    | { readonly action: "accept-url" }
    | { readonly action: "decline" }
    | { readonly action: "cancel" };

export type MortyInteractionResponseRequest =
    | { readonly kind: "permission"; readonly answer: MortyPermissionAnswer }
    | { readonly kind: "elicitation"; readonly answer: MortyElicitationAnswer };

export class MortyPageRequest {
    readonly cursor: string;
    readonly limit: number;

    constructor(limit: number, cursor: string) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || cursor.length > 512) {
            throw new MortyValidationError("The page request is invalid");
        }
        this.cursor = cursor;
        this.limit = limit;
    }
}
