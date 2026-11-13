import type {
    PromptAttachment,
    SessionConfigurationSelection,
    SessionPromptDisposition,
    TurnCancellation,
} from "@morty-build/client/protocol";

import { MortyValidationError } from "./errors.ts";

/** A Turn's content. The Computer runs it with the Agent and directory of the Session it holds. */
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

/** How a cancelled Turn ended: `cancelled`, or the Agent's stop reason when the Turn finished first. */
export type MortyTurnCancellation = TurnCancellation;

export type MortyInteractionResponseRequest =
    | {
          readonly kind: "permission";
          readonly responderId: string;
          readonly optionId: string;
          readonly outcome: string;
      }
    | {
          readonly kind: "elicitation";
          readonly responderId: string;
          readonly action: string;
          readonly content: string;
      };

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
