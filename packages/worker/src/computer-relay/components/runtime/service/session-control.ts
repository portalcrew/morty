import {
    decodeNativeSessionRequest,
    decodeNativeSessionTarget,
    decodeSessionCancelBeforeStartCommand,
    decodeSessionCancelCommand,
    decodeSessionConfigReadCommand,
    decodeSessionConfigureCommand,
    decodeSessionElicitationRespondCommand,
    decodeSessionHistoryPageLoad,
    decodeSessionPermissionRespondCommand,
    decodeSessionPreviewHistoryPageLoad,
    decodeSessionPromptCommand,
    decodeSessionPromptDispositionCommand,
    decodeSessionRenameCommand,
    type NativeSessionTarget,
    ProtocolMessageError,
    type SessionConfigurationSelection,
    type SessionPromptCommand,
} from "@morty-build/client/protocol";
import { PairingDirectoryError } from "../../../../contracts/relay/pairing.ts";
import type { ComputerControlCommand, ComputerControlResult } from "./computer-control-request.ts";

/** Runs one command of a Session operation on a Computer once the caller is authorized, and returns the answer. */
export type ComputerControl = (command: ComputerControlCommand) => Promise<ComputerControlResult>;

/** A Turn for an existing Session. The Computer runs it with the Agent and directory of the Session it holds. */
export interface TurnSubmission {
    readonly commandId: string;
    readonly content: string;
    readonly attachments: readonly unknown[];
    readonly disposition: string;
    readonly targetCommandId?: string | undefined;
    readonly sessionConfigurations: readonly unknown[];
}

/**
 * Where a submitted Turn's command stands when the Computer answers its submission. `settled` answers a retried command
 * that had already ended: the Computer states neither how nor when it ended, so the command's own lifecycle events
 * carry its outcome.
 */
export interface TurnAdmission {
    readonly commandId: string;
    readonly state: "queued" | "running" | "settled";
}

export type InteractionResponse =
    | { readonly kind: "permission"; readonly optionId: string; readonly outcome: "cancelled" | "selected" }
    | { readonly kind: "elicitation"; readonly action: "accept" | "cancel" | "decline"; readonly content: string };

export type SessionConfiguration = SessionConfigurationSelection & {
    readonly expectedConfigurationRevision: string;
};

/**
 * The operations every Session API offers on one Session. Each builds the Computer command for the Session's target
 * alone, runs it through the caller's authorized control and checks that the answer belongs to that command. The
 * Computer resolves the Session's Agent and directory from the Session it holds. Routes authenticate, decode their own request format and shape their own response; they do
 * not repeat these rules.
 */
export class SessionControl {
    readonly #control: ComputerControl;
    readonly #target: NativeSessionTarget;

    constructor(control: ComputerControl, target: NativeSessionTarget) {
        this.#control = control;
        this.#target = decodeNativeSessionTarget(target);
    }

    readonly submitTurn = async (turn: TurnSubmission): Promise<TurnAdmission> => {
        let command: SessionPromptCommand;
        try {
            command = decodeSessionPromptCommand(
                JSON.stringify({
                    attachments: turn.attachments,
                    commandId: turn.commandId,
                    requestId: turn.commandId,
                    disposition: turn.disposition,
                    kind: "session.prompt",
                    prompt: turn.content,
                    sessionConfigurations: turn.sessionConfigurations,
                    target: this.#target,
                    targetCommandId: turn.targetCommandId,
                }),
            );
        } catch (error) {
            // The caller supplied this prompt, so protocol rejection is a client error, not a retryable outage.
            if (error instanceof ProtocolMessageError) {
                throw new PairingDirectoryError("invalid_request", "The Turn request is invalid", { cause: error });
            }
            throw error;
        }
        const result = await this.#control(command);
        if (result.kind !== "session.prompt.accepted" || result.requestId !== command.commandId) {
            throw new PairingDirectoryError("invalid_request", "The Computer returned an invalid Turn");
        }
        return { commandId: result.requestId, state: result.state };
    };

    readonly cancelTurn = async (turnId: string): Promise<{ readonly stopReason: string }> => {
        const stopped = await this.#run(
            decodeSessionCancelCommand(
                JSON.stringify({
                    commandId: turnId,
                    kind: "session.cancel",
                    requestId: crypto.randomUUID(),
                    target: this.#target,
                }),
            ),
        );
        if (stopped.kind !== "session.turn.stopped" || stopped.commandId !== turnId) {
            throw new PairingDirectoryError("invalid_request", "The Computer returned an invalid cancellation");
        }
        return { stopReason: stopped.stopReason };
    };

    /** Withdraws a Turn that has not started; one that already started cannot be withdrawn. */
    readonly withdrawTurn = async (turnId: string): Promise<void> => {
        const withdrawn = await this.#run(
            decodeSessionCancelBeforeStartCommand(
                JSON.stringify({
                    commandId: turnId,
                    kind: "session.cancel-before-start",
                    requestId: crypto.randomUUID(),
                    target: this.#target,
                }),
            ),
        );
        if (withdrawn.kind !== "session.turn.withdrawn" || withdrawn.commandId !== turnId) {
            throw new PairingDirectoryError("invalid_request", "The Computer returned an invalid cancellation");
        }
    };

    readonly steerTurn = async (turnId: string): Promise<void> => {
        const steered = await this.#run(
            decodeSessionPromptDispositionCommand(
                JSON.stringify({
                    commandId: turnId,
                    disposition: "steer",
                    kind: "session.prompt.disposition",
                    requestId: crypto.randomUUID(),
                    target: this.#target,
                }),
            ),
        );
        if (steered.kind !== "session.prompt.steered" || steered.commandId !== turnId) {
            throw new PairingDirectoryError("invalid_request", "The Computer returned an invalid steered Turn");
        }
    };

    readonly respond = async (interactionId: string, response: InteractionResponse): Promise<void> => {
        const requestId = crypto.randomUUID();
        const answered = await this.#run(
            response.kind === "permission"
                ? decodeSessionPermissionRespondCommand(
                      JSON.stringify({
                          interactionId,
                          kind: "session.permission.respond",
                          optionId: response.optionId,
                          outcome: response.outcome,
                          requestId,
                          target: this.#target,
                      }),
                  )
                : decodeSessionElicitationRespondCommand(
                      JSON.stringify({
                          action: response.action,
                          content: response.content,
                          interactionId,
                          kind: "session.elicitation.respond",
                          requestId,
                          target: this.#target,
                      }),
                  ),
        );
        if (answered.kind !== "session.interaction.answered" || answered.interactionId !== interactionId) {
            throw new PairingDirectoryError("invalid_request", "The Computer returned an invalid answer");
        }
    };

    readonly readConfiguration = async () => {
        const result = await this.#run(
            decodeSessionConfigReadCommand(
                JSON.stringify({
                    kind: "session.config.read",
                    requestId: crypto.randomUUID(),
                    target: this.#target,
                }),
            ),
        );
        if (result.kind !== "session.config.read.result") {
            throw new PairingDirectoryError("invalid_request", "The Computer returned invalid Session settings");
        }
        return result;
    };

    readonly configure = async (configuration: SessionConfiguration) =>
        await this.#run(
            decodeSessionConfigureCommand(
                JSON.stringify({
                    ...configuration,
                    kind: "session.configure",
                    requestId: crypto.randomUUID(),
                    target: this.#target,
                }),
            ),
        );

    readonly rename = async (title: string) =>
        await this.#run(
            decodeSessionRenameCommand(
                JSON.stringify({
                    kind: "session.rename",
                    requestId: crypto.randomUUID(),
                    target: this.#target,
                    title,
                }),
            ),
        );

    /** The Session's running Turn, and the delivery of `deliveryCommandId` when the caller names one. */
    readonly activeTurn = async (deliveryCommandId?: string) => {
        const result = await this.#control(
            decodeNativeSessionRequest(
                JSON.stringify({
                    action: "active-turn",
                    ...(deliveryCommandId === undefined ? {} : { deliveryCommandId }),
                    kind: "native.session.request",
                    requestId: crypto.randomUUID(),
                    target: this.#target,
                }),
            ),
        );
        if (result.kind !== "native.session.result" || result.action !== "active-turn") {
            throw new PairingDirectoryError("invalid_request", "The Computer returned an invalid active Turn");
        }
        return result;
    };

    /** A page of the Agent's own history of the native session in `directory`, which the caller browses. */
    readonly previewEvents = async (
        directory: string,
        page: { readonly cursor: string | null; readonly eventLimit: number },
    ) => {
        const result = await this.#run(
            decodeSessionPreviewHistoryPageLoad(
                JSON.stringify({
                    cursor: page.cursor,
                    directory,
                    eventLimit: page.eventLimit,
                    kind: "session.preview-history.page.load",
                    requestId: crypto.randomUUID(),
                    target: this.#target,
                }),
            ),
        );
        if (result.kind !== "session.preview-history.page.loaded") {
            throw new PairingDirectoryError("invalid_request", "The Computer returned invalid V2 Session events");
        }
        return result.events;
    };

    /** A page of the Session's live history. */
    readonly liveEvents = async (page: { readonly cursor: string | null; readonly eventLimit: number }) => {
        const result = await this.#run(
            decodeSessionHistoryPageLoad(
                JSON.stringify({
                    cursor: page.cursor,
                    eventLimit: page.eventLimit,
                    kind: "session.live-history.v2.page.load",
                    requestId: crypto.randomUUID(),
                    target: this.#target,
                }),
            ),
        );
        if (result.kind !== "session.live-history.v2.page.loaded") {
            throw new PairingDirectoryError("invalid_request", "The Computer returned invalid V2 Session events");
        }
        return result.events.events;
    };

    readonly #run = async (command: ComputerControlCommand): Promise<ComputerControlResult> =>
        await this.#control(command);
}
