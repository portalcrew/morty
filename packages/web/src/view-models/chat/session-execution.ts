import type { MortyClient, MortyTurnAdmission } from "@portalcrew/morty-client";
import { createStore } from "zustand/vanilla";
import type { SessionActivityState } from "./session-activity-machine.ts";
import {
    acceptedTurn,
    type CurrentTurn,
    idleTurn,
    type TurnFailure,
    transitionCurrentTurn,
} from "./session-current-turn.ts";
import type { DeliveryPlacement, DeliveryState } from "./session-delivery-store.ts";
import { type DelegationStage, requestedInteraction, type SessionLifecycleFact } from "./session-lifecycle.ts";
import type { SessionInteraction } from "./session-pane-types.ts";
import type { SessionExecutionObservation } from "./session-presentation.ts";

// What the page knows about one Session's execution: the current turn, the Computer's queue, the Agent's pending
// requests, and what the Computer has shown of each command. Every fact about the execution, a live lifecycle event, an
// execution read, the service's acceptance of a submission, enters through `applyExecutionFact`, and only there is it
// decided whether a fact is newer than what the state already holds. The page keeps this state for the Session, so it
// outlives the pane that follows the Session; the pane feeds facts in and performs the reads the transitions ask for.

type SessionExecutionSnapshot = Awaited<ReturnType<MortyClient["sessions"]["readSessionExecution"]>>;

export type QueuedCommand = SessionExecutionSnapshot["queued"][number];

type LogPosition = SessionExecutionSnapshot["executionPosition"];

type TurnOutcome =
    | { readonly kind: "completed" }
    /** Steering ended the turn, but its execution goes on; only a read tells what runs now. */
    | { readonly kind: "steered" }
    | { readonly kind: "failed"; readonly failure: TurnFailure };

type InteractionChange = Extract<
    SessionLifecycleFact,
    { readonly kind: "interaction-requested" | "permission-resolved" | "elicitation-resolved" }
>;

export type LiveExecutionChange =
    | InteractionChange
    /** The Computer's queue changed; only a read tells what it holds now. */
    | { readonly kind: "queue-changed" }
    /**
     * The Computer started the command at `startedAt`. A command that `steers` joined the running execution instead of
     * starting one, so it does not become the turn to stop.
     */
    | {
          readonly kind: "turn-started";
          readonly commandId: string;
          readonly startedAt: number;
          readonly steers: boolean;
      }
    | {
          readonly kind: "turn-delegated";
          readonly commandId: string;
          readonly stage: DelegationStage;
          readonly at: number;
      }
    | { readonly kind: "turn-ended"; readonly commandId: string; readonly outcome: TurnOutcome };

type LiveExecutionFact = {
    readonly kind: "live";
    readonly sessionGenerationId: string;
    readonly position: string;
    readonly change: LiveExecutionChange;
};

export type SessionExecutionFact =
    /**
     * A pane starts following the Session. Until the pane's first read, the queue and requests this page last saw may be
     * out of date, and nothing orders live facts.
     */
    | { readonly kind: "opened" }
    | LiveExecutionFact
    | {
          readonly kind: "read";
          readonly snapshot: SessionExecutionSnapshot;
          readonly basis: number;
      }
    | {
          readonly kind: "acknowledged";
          readonly commandId: string;
          readonly admission: MortyTurnAdmission;
          readonly startedAt: number;
      }
    /** This page submits a new turn, so the failure reported for an earlier one no longer describes the Session. */
    | { readonly kind: "turn-submitted" }
    | { readonly kind: "history"; readonly shown: readonly string[]; readonly recorded: readonly string[] }
    | { readonly kind: "closed" };

interface RuntimeCommand {
    /**
     * When this page learned the Computer holds the command: how many commands it had learned of before. Commands are
     * never forgotten, so this orders them in the order they were learned.
     */
    readonly learnedAt: number;
    readonly shown: boolean;
    readonly ended: boolean;
    /** What the Computer answered when this page submitted the command; null for a command it learned of otherwise. */
    readonly admission: MortyTurnAdmission | null;
}

type ExecutionCoverage =
    /**
     * No read since the pane started following the Session. The first read is the baseline, and the live facts that
     * arrive meanwhile wait: it covers only those up to its position.
     */
    | { readonly kind: "unread"; readonly held: readonly LiveExecutionFact[] }
    | { readonly kind: "covered"; readonly position: LogPosition }
    | { readonly kind: "awaiting-read"; readonly position: LogPosition; readonly held: readonly LiveExecutionFact[] };

export interface SessionExecutionState {
    readonly coverage: ExecutionCoverage;
    readonly turn: CurrentTurn;
    readonly queued: readonly QueuedCommand[];
    readonly listing: { readonly queued: ReadonlySet<string>; readonly basis: number } | null;
    readonly interactions: readonly SessionInteraction[];
    readonly commands: ReadonlyMap<string, RuntimeCommand>;
    readonly observations: readonly SessionExecutionObservation[];
}

type SessionExecutionEffect = { readonly kind: "read" };

interface SessionExecutionTransition {
    readonly state: SessionExecutionState;
    readonly effects: readonly SessionExecutionEffect[];
}

const initialSessionExecution: SessionExecutionState = {
    coverage: { kind: "unread", held: [] },
    turn: idleTurn,
    queued: [],
    listing: null,
    interactions: [],
    commands: new Map(),
    observations: [],
};

const readEffect: SessionExecutionEffect = { kind: "read" };

function settled(state: SessionExecutionState): SessionExecutionTransition {
    return { state, effects: [] };
}

function learn(
    state: SessionExecutionState,
    commandIds: readonly string[],
    fact: "holds" | "shows" | "ended",
): SessionExecutionState {
    let commands: Map<string, RuntimeCommand> | null = null;
    for (const commandId of commandIds) {
        const current = commands ?? state.commands;
        const known = current.get(commandId);
        const base = known ?? { learnedAt: current.size, shown: false, ended: false, admission: null };
        const next = fact === "shows" ? { ...base, shown: true } : fact === "ended" ? { ...base, ended: true } : base;
        if (known !== undefined && next.shown === known.shown && next.ended === known.ended) {
            continue;
        }
        commands ??= new Map(state.commands);
        commands.set(commandId, next);
    }
    return commands === null ? state : { ...state, commands };
}

function admit(state: SessionExecutionState, commandId: string, admission: MortyTurnAdmission): SessionExecutionState {
    const learned = learn(state, [commandId], "holds");
    const command = learned.commands.get(commandId);
    if (command === undefined || command.admission === admission) {
        return learned;
    }
    return { ...learned, commands: new Map(learned.commands).set(commandId, { ...command, admission }) };
}

function commandEnded(state: Pick<SessionExecutionState, "commands">, commandId: string): boolean {
    return state.commands.get(commandId)?.ended === true;
}

function interactionId(interaction: SessionInteraction): string {
    return interaction.kind === "permission"
        ? interaction.permission.interactionId
        : interaction.elicitation.interactionId;
}

function transitionInteractions(
    current: readonly SessionInteraction[],
    change: InteractionChange,
): readonly SessionInteraction[] {
    switch (change.kind) {
        case "interaction-requested": {
            const id = interactionId(change.interaction);
            return [...current.filter((interaction) => interactionId(interaction) !== id), change.interaction];
        }
        case "permission-resolved":
            return current.map((interaction): SessionInteraction => {
                if (
                    interaction.kind !== "permission" ||
                    interaction.permission.interactionId !== change.interactionId ||
                    interaction.permission.state.kind === "resolved"
                ) {
                    return interaction;
                }
                return {
                    kind: "permission",
                    permission: {
                        ...interaction.permission,
                        state: { kind: "resolved", answer: change.answer },
                    },
                };
            });
        case "elicitation-resolved":
            return current.map((interaction): SessionInteraction => {
                if (
                    interaction.kind !== "elicitation" ||
                    interaction.elicitation.interactionId !== change.interactionId ||
                    interaction.elicitation.state.kind === "resolved"
                ) {
                    return interaction;
                }
                return {
                    kind: "elicitation",
                    elicitation: {
                        ...interaction.elicitation,
                        state: { action: change.action, kind: "resolved" },
                    },
                };
            });
        default:
            return change satisfies never;
    }
}

function applyLiveChange(state: SessionExecutionState, change: LiveExecutionChange): SessionExecutionTransition {
    switch (change.kind) {
        case "interaction-requested":
        case "permission-resolved":
        case "elicitation-resolved":
            return settled({ ...state, interactions: transitionInteractions(state.interactions, change) });
        case "queue-changed":
            return { state, effects: [readEffect] };
        case "turn-started": {
            const { commandId, startedAt } = change;
            const known = learn(state, [commandId], "holds");
            return settled({
                ...known,
                queued: known.queued.some((item) => item.commandId === commandId)
                    ? known.queued.filter((item) => item.commandId !== commandId)
                    : known.queued,
                // Steering starts a command, not a new execution to stop.
                turn: change.steers
                    ? known.turn
                    : transitionCurrentTurn(known.turn, {
                          kind: "running",
                          commandId,
                          startedAt,
                      }),
            });
        }
        case "turn-delegated": {
            const known = learn(state, [change.commandId], "holds");
            return settled({
                ...known,
                turn: transitionCurrentTurn(known.turn, {
                    kind: "delegated",
                    commandId: change.commandId,
                    stage: change.stage,
                    at: change.at,
                }),
            });
        }
        case "turn-ended": {
            const { commandId, outcome } = change;
            if (outcome.kind === "steered") {
                // Steering ended the turn but not its execution; only a read tells what runs now.
                return { state: learn(state, [commandId], "holds"), effects: [readEffect] };
            }
            const known = learn(state, [commandId], "ended");
            return settled({
                ...known,
                turn: transitionCurrentTurn(known.turn, {
                    kind: "ended",
                    commandId,
                    failure: outcome.kind === "failed" ? outcome.failure : null,
                }),
            });
        }
        default:
            return change satisfies never;
    }
}

function applyCoveredLive(
    state: SessionExecutionState,
    position: LogPosition,
    fact: LiveExecutionFact,
): SessionExecutionTransition {
    if (BigInt(fact.position) <= BigInt(position.throughPosition)) {
        return settled(state);
    }
    return applyLiveChange(
        {
            ...state,
            coverage: {
                kind: "covered",
                position: { sessionGenerationId: fact.sessionGenerationId, throughPosition: fact.position },
            },
        },
        fact.change,
    );
}

function applyLive(state: SessionExecutionState, fact: LiveExecutionFact): SessionExecutionTransition {
    const { coverage } = state;
    switch (coverage.kind) {
        case "unread":
        case "awaiting-read":
            return settled({ ...state, coverage: { ...coverage, held: [...coverage.held, fact] } });
        case "covered":
            if (fact.sessionGenerationId !== coverage.position.sessionGenerationId) {
                return {
                    state: { ...state, coverage: { kind: "awaiting-read", position: coverage.position, held: [fact] } },
                    effects: [readEffect],
                };
            }
            return applyCoveredLive(state, coverage.position, fact);
        default:
            return coverage satisfies never;
    }
}

function replayHeld(
    transition: SessionExecutionTransition,
    held: readonly LiveExecutionFact[],
): SessionExecutionTransition {
    let { state, effects } = transition;
    for (const fact of held) {
        if (
            state.coverage.kind !== "covered" ||
            fact.sessionGenerationId !== state.coverage.position.sessionGenerationId
        ) {
            continue;
        }
        const next = applyCoveredLive(state, state.coverage.position, fact);
        state = next.state;
        effects = [...effects, ...next.effects];
    }
    return { state, effects };
}

function applyRead(
    state: SessionExecutionState,
    fact: Extract<SessionExecutionFact, { readonly kind: "read" }>,
): SessionExecutionTransition {
    const { snapshot, basis } = fact;
    const { coverage } = state;
    const position = snapshot.executionPosition;
    const held = coverage.kind === "covered" ? [] : coverage.held;
    if (
        coverage.kind !== "unread" &&
        coverage.position.sessionGenerationId === position.sessionGenerationId &&
        BigInt(position.throughPosition) < BigInt(coverage.position.throughPosition)
    ) {
        return replayHeld(settled({ ...state, coverage: { kind: "covered", position: coverage.position } }), held);
    }
    const running = snapshot.turn;
    // Only the Computer knows whether a submission arrived, including one that finished while no pane followed the
    // Session. A submission the Computer has no receipt for stays unconfirmed. The execution receipt of a running command confirms its delivery even when admission and live events were lost.
    let next = learn(
        state,
        [
            ...snapshot.queued.map((item) => item.commandId),
            ...(snapshot.delivery?.state === "received" ? [snapshot.delivery.commandId] : []),
            ...(running === null ? [] : [running.commandId]),
        ],
        "holds",
    );
    let turn = next.turn;
    if (running !== null) {
        turn = transitionCurrentTurn(turn, {
            kind: "running",
            commandId: running.commandId,
            startedAt: Date.parse(running.startedAt),
        });
        if (running.delegation !== null) {
            turn = transitionCurrentTurn(turn, {
                kind: "delegated",
                commandId: running.commandId,
                stage: running.delegation.stage,
                at: Date.parse(running.delegation.at),
            });
        }
    } else {
        // Only a turn this page learned of before the read began can have ended by the time it was served.
        if (turn.kind === "current" && (state.commands.get(turn.commandId)?.learnedAt ?? -1) < basis) {
            turn = transitionCurrentTurn(turn, { kind: "nothing-running" });
        }
        // A retained outcome describes the last settled command. Repeating an outcome already observed cannot undo
        // what this page did since; a genuinely unseen one recovers a turn that ended while no pane followed it.
        const lastTurn = snapshot.lastTurn;
        if (lastTurn !== undefined && !commandEnded(next, lastTurn.commandId)) {
            turn = transitionCurrentTurn(turn, {
                kind: "last-turn-reported",
                commandId: lastTurn.commandId,
                failure: lastTurn.state === "failed" ? { code: lastTurn.code, message: lastTurn.message } : null,
            });
            next = learn(next, [lastTurn.commandId], "ended");
        }
    }
    const queued = snapshot.queued.map((item) => item.commandId);
    return replayHeld(
        {
            state: {
                ...next,
                coverage: { kind: "covered", position },
                turn,
                queued: snapshot.queued,
                listing: { queued: new Set(queued), basis },
                interactions: snapshot.interactions.map(requestedInteraction),
                observations: [
                    ...next.observations.filter(
                        (observation) =>
                            observation.kind === "through" && observation.generation === position.sessionGenerationId,
                    ),
                    {
                        kind: "through",
                        generation: position.sessionGenerationId,
                        position: position.throughPosition,
                        running: running?.commandId ?? null,
                        queued,
                    },
                ],
            },
            effects: [],
        },
        held,
    );
}

function applyExecutionFact(state: SessionExecutionState, fact: SessionExecutionFact): SessionExecutionTransition {
    switch (fact.kind) {
        case "opened": {
            const opened: SessionExecutionState = {
                ...state,
                coverage: { kind: "unread", held: [] },
                queued: [],
                listing: null,
                interactions: [],
            };
            return settled({ ...opened, turn: transitionCurrentTurn(opened.turn, { kind: "nothing-running" }) });
        }
        case "live":
            return applyLive(state, fact);
        case "read":
            return applyRead(state, fact);
        case "acknowledged": {
            const known = admit(state, fact.commandId, fact.admission);
            // Only a message the Computer started running is a turn. A queued one starts none yet, and a settled one
            // ended before this answer, its outcome is the Session's account; a terminal live event can also precede
            // the answer, and the turn it ended stays ended.
            if (fact.admission !== "running" || commandEnded(state, fact.commandId)) {
                return settled(known);
            }
            return settled({
                ...known,
                turn: transitionCurrentTurn(known.turn, {
                    kind: "accepted",
                    commandId: fact.commandId,
                    startedAt: fact.startedAt,
                }),
            });
        }
        case "turn-submitted": {
            const turn = transitionCurrentTurn(state.turn, { kind: "new-turn-submitted" });
            return settled(turn === state.turn ? state : { ...state, turn });
        }
        case "history":
            return settled(learn(learn(state, fact.recorded, "holds"), fact.shown, "shows"));
        case "closed":
            return {
                state: {
                    ...state,
                    turn: transitionCurrentTurn(state.turn, { kind: "nothing-running" }),
                    queued: [],
                    interactions: [],
                    observations: [...state.observations, { kind: "closed" }],
                },
                effects: [],
            };
        default:
            return fact satisfies never;
    }
}

export function executionReadBasis(state: SessionExecutionState): number {
    return state.commands.size;
}

export function runtimeHoldsCommand(state: SessionExecutionState, commandId: string): boolean {
    return state.commands.has(commandId);
}

/**
 * Where the Computer admitted a message. Its answer to this page's submission decides; until it answers, the placement
 * the page expected stands.
 */
export function admittedPlacement(
    state: SessionExecutionState,
    message: { readonly commandId: string; readonly placement: DeliveryPlacement },
): DeliveryPlacement {
    const admission = state.commands.get(message.commandId)?.admission ?? null;
    if (admission === null) {
        return message.placement;
    }
    return admission === "queued" ? "queue" : "turn";
}

/**
 * Whether the Computer's own account now shows a message the service accepted, so the page no longer needs its copy.
 * A message that runs as a turn is covered once the timeline shows it; history names each turn's command. A message
 * shown in the queue keeps its files there until it starts or a read that could see it no longer lists it.
 */
export function runtimeCoversMessage(
    state: SessionExecutionState,
    message: { readonly commandId: string; readonly placement: DeliveryPlacement },
): boolean {
    const command = state.commands.get(message.commandId);
    if (command === undefined) {
        return false;
    }
    if (command.shown) {
        return true;
    }
    if (admittedPlacement(state, message) === "turn") {
        return false;
    }
    return (
        acceptedTurn(state.turn)?.commandId === message.commandId ||
        (state.listing !== null &&
            command.learnedAt < state.listing.basis &&
            !state.listing.queued.has(message.commandId))
    );
}

/** The questions the Computer's account leaves pending, or null while this page has no account of them yet. */
export function pendingQuestions(state: SessionExecutionState): ReadonlySet<string> | null {
    return state.coverage.kind === "covered" ? pendingQuestionIds(state.interactions) : null;
}

function pendingQuestionIds(interactions: readonly SessionInteraction[]): ReadonlySet<string> {
    return new Set(
        interactions.flatMap((interaction) =>
            interaction.kind === "elicitation" && interaction.elicitation.state.kind === "pending"
                ? [interaction.elicitation.interactionId]
                : [],
        ),
    );
}

export function waitingForInput(interactions: readonly SessionInteraction[]): boolean {
    return interactions.some(
        (interaction) =>
            (interaction.kind === "permission" && interaction.permission.state.kind !== "resolved") ||
            (interaction.kind === "elicitation" &&
                (interaction.elicitation.state.kind === "pending" ||
                    interaction.elicitation.state.kind === "submitted")),
    );
}

function submittingCommandId(
    execution: Pick<SessionExecutionState, "turn" | "commands">,
    delivery: DeliveryState,
): string | null {
    if (execution.turn.kind === "current") {
        return null;
    }
    const commandId =
        delivery.kind === "preparing" && delivery.message.placement === "turn"
            ? delivery.message.commandId
            : delivery.kind === "submitting" && delivery.journal.placement === "turn"
              ? delivery.journal.commandId
              : null;
    return commandId !== null && commandEnded(execution, commandId) ? null : commandId;
}

/**
 * What the page reports for the Session: working while a command is current or this page submits a new turn;
 * otherwise failed while a message that would have started a turn keeps the failure of its preparation, or after the
 * service reported a failed turn; otherwise idle. A message the service rejected reports its failure on the message
 * alone.
 */
export function sessionActivity(
    execution: Pick<SessionExecutionState, "turn" | "commands">,
    delivery: DeliveryState,
): SessionActivityState {
    const { turn } = execution;
    if (turn.kind === "current") {
        return { kind: "working", commandId: turn.commandId };
    }
    const submitting = submittingCommandId(execution, delivery);
    if (submitting !== null) {
        return { kind: "working", commandId: submitting };
    }
    if (delivery.kind === "preparation-failed" && delivery.message.placement === "turn") {
        return { kind: "failed", commandId: delivery.message.commandId, ...delivery.failure };
    }
    return turn.failure === null ? { kind: "idle" } : { kind: "failed", ...turn.failure };
}

export interface SessionExecutionStore {
    readonly state: SessionExecutionState;
    readonly apply: (fact: SessionExecutionFact) => readonly SessionExecutionEffect[];
}

export function createSessionExecutionStore() {
    return createStore<SessionExecutionStore>()((set, get) => ({
        state: initialSessionExecution,
        apply: (fact) => {
            const previous = get().state;
            const { state, effects } = applyExecutionFact(previous, fact);
            if (state !== previous) {
                set({ state });
            }
            return effects;
        },
    }));
}

export const noSessionExecution = createStore<Pick<SessionExecutionStore, "state">>()(() => ({
    state: initialSessionExecution,
}));
