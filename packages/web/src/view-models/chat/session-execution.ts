import type { MortyClient } from "@portalcrew/morty-client";
import type { CommandStanding } from "@portalcrew/morty-client/protocol";
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
// execution read, the Computer's answer about a command, enters through `applyExecutionFact`, and only there is it
// decided, by the Session log position each fact holds at, whether a fact is newer than what the state already holds.
// The page keeps this state for the Session, so it outlives the pane that follows the Session; the pane feeds facts in
// and performs the reads the transitions ask for.

type SessionExecutionSnapshot = Awaited<ReturnType<MortyClient["sessions"]["readSessionExecution"]>>;

export type QueuedCommand = SessionExecutionSnapshot["queued"][number];

type LogPosition = SessionExecutionSnapshot["executionPosition"];

/**
 * What the Computer answered about one command, by replying to a request about it or in a read: where the command
 * stands, or, answering a request on a queued command, that it left the queue without running or to join the running
 * turn.
 */
type CommandAnswer =
    | Exclude<CommandStanding, { readonly state: "unknown" }>
    | { readonly state: "withdrawn" }
    | { readonly state: "steered" };

interface PositionedAnswer {
    readonly answer: CommandAnswer;
    readonly position: LogPosition;
}

type TurnOutcome =
    | { readonly kind: "completed" }
    /** Steering ended the turn, but its execution goes on; only a read tells what runs now. */
    | { readonly kind: "steered" }
    | { readonly kind: "failed"; readonly failure: TurnFailure };

type InteractionChange = Extract<
    SessionLifecycleFact,
    { readonly kind: "interaction-requested" | "permission-resolved" | "elicitation-resolved" }
>;

type StopChange = Extract<SessionLifecycleFact, { readonly kind: "turn-stop-changed" }>;

export type LiveExecutionChange =
    | InteractionChange
    | StopChange
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
    | { readonly kind: "read"; readonly snapshot: SessionExecutionSnapshot }
    | CommandAnswered
    /** This page submits a new turn, so the failure reported for an earlier one no longer describes the Session. */
    | { readonly kind: "turn-submitted" }
    | { readonly kind: "history"; readonly shown: readonly string[]; readonly recorded: readonly string[] }
    | { readonly kind: "closed" };

/** The Computer's answer about a command, with the Session log position at which it holds. */
export type CommandAnswered = {
    readonly kind: "answered";
    readonly commandId: string;
    readonly answer: CommandAnswer;
    readonly position: LogPosition;
};

interface RuntimeCommand {
    readonly shown: boolean;
    readonly ended: boolean;
    /** The latest answer about the command, by a reply or a read; null while the Computer gave none. */
    readonly answer: PositionedAnswer | null;
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
    /**
     * The Computer's queue as the latest read listed it at `through`, less the commands live events since showed
     * starting; null before the pane's first read.
     */
    readonly queue: { readonly through: LogPosition; readonly commands: readonly QueuedCommand[] } | null;
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
    queue: null,
    interactions: [],
    commands: new Map(),
    observations: [],
};

const readEffect: SessionExecutionEffect = { kind: "read" };

const unansweredCommand: RuntimeCommand = { shown: false, ended: false, answer: null };

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
        const base = known ?? unansweredCommand;
        const next = fact === "shows" ? { ...base, shown: true } : fact === "ended" ? { ...base, ended: true } : base;
        if (known !== undefined && next.shown === known.shown && next.ended === known.ended) {
            continue;
        }
        commands ??= new Map(state.commands);
        commands.set(commandId, next);
    }
    return commands === null ? state : { ...state, commands };
}

/**
 * Whether an answer holds beyond what an account through `through` reflects; anything holds beyond no account at all.
 * Positions of different generations do not order, so an account of another generation supersedes the answer.
 */
function answerBeyond(answered: PositionedAnswer, through: LogPosition | null): boolean {
    return (
        through === null ||
        (through.sessionGenerationId === answered.position.sessionGenerationId &&
            BigInt(answered.position.throughPosition) > BigInt(through.throughPosition))
    );
}

function coveredThrough(coverage: ExecutionCoverage): LogPosition | null {
    return coverage.kind === "unread" ? null : coverage.position;
}

/** Records an answer unless the page holds a later one about the command. */
function recordAnswer(
    state: SessionExecutionState,
    commandId: string,
    answer: CommandAnswer,
    position: LogPosition,
): SessionExecutionState {
    const learned = learn(state, [commandId], "holds");
    const command = learned.commands.get(commandId) ?? unansweredCommand;
    if (command.answer !== null && answerBeyond(command.answer, position)) {
        return learned;
    }
    return {
        ...learned,
        commands: new Map(learned.commands).set(commandId, { ...command, answer: { answer, position } }),
    };
}

/** Whether the page holds an answer that the command runs from a position beyond `through`. */
function runsBeyond(state: SessionExecutionState, commandId: string, through: LogPosition): boolean {
    const answered = state.commands.get(commandId)?.answer ?? null;
    return answered?.answer.state === "running" && answerBeyond(answered, through);
}

export function commandEnded(state: Pick<SessionExecutionState, "commands">, commandId: string): boolean {
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
                queue:
                    known.queue?.commands.some((item) => item.commandId === commandId) === true
                        ? {
                              ...known.queue,
                              commands: known.queue.commands.filter((item) => item.commandId !== commandId),
                          }
                        : known.queue,
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
        case "turn-stop-changed":
            return settled({
                ...state,
                turn: transitionCurrentTurn(state.turn, {
                    kind: "stop-reported",
                    commandId: change.commandId,
                    stop: change.stop,
                }),
            });
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
    const { snapshot } = fact;
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
    // A read answers, as of its position, that each command it lists waits in the queue. Only the Computer knows where
    // a submission stands, including one that finished while no pane followed the Session; one it has no receipt for
    // stays unconfirmed.
    let next = learn(state, running === null ? [] : [running.commandId], "holds");
    for (const item of snapshot.queued) {
        next = recordAnswer(next, item.commandId, { state: "queued" }, position);
    }
    const delivery = snapshot.delivery;
    if (delivery !== undefined && delivery.standing.state !== "unknown") {
        next = recordAnswer(next, delivery.commandId, delivery.standing, position);
    }
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
        turn = transitionCurrentTurn(turn, { kind: "stop-reported", commandId: running.commandId, stop: running.stop });
    } else {
        // The read covers every answer up to its position, so only a turn an answer beyond it reported still runs.
        if (turn.kind === "current" && !runsBeyond(next, turn.commandId, position)) {
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
    return replayHeld(
        {
            state: {
                ...next,
                coverage: { kind: "covered", position },
                turn,
                queue: { through: position, commands: snapshot.queued },
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
                        queued: snapshot.queued.map((item) => item.commandId),
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
                queue: null,
                interactions: [],
            };
            return settled({ ...opened, turn: transitionCurrentTurn(opened.turn, { kind: "nothing-running" }) });
        }
        case "live":
            return applyLive(state, fact);
        case "read":
            return applyRead(state, fact);
        case "answered": {
            const next = recordAnswer(state, fact.commandId, fact.answer, fact.position);
            const answered = next.commands.get(fact.commandId)?.answer ?? null;
            // An answer the page's account already covers is reflected there, or superseded since; only a newer one
            // tells of a turn that reads and live events have not shown yet. Only a running command is a turn.
            if (answered?.answer.state !== "running" || !answerBeyond(answered, coveredThrough(state.coverage))) {
                return settled(next);
            }
            return settled({
                ...next,
                turn: transitionCurrentTurn(next.turn, {
                    kind: "accepted",
                    commandId: fact.commandId,
                    startedAt: Date.parse(answered.answer.startedAt),
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
                    queue: state.queue === null ? null : { ...state.queue, commands: [] },
                    interactions: [],
                    observations: [...state.observations, { kind: "closed" }],
                },
                effects: [],
            };
        default:
            return fact satisfies never;
    }
}

export function runtimeHoldsCommand(state: SessionExecutionState, commandId: string): boolean {
    return state.commands.has(commandId);
}

/** The latest answer about a command, or null while the page holds none. */
function commandAnswer(state: SessionExecutionState, commandId: string): CommandAnswer | null {
    return state.commands.get(commandId)?.answer?.answer ?? null;
}

/**
 * The Computer's queue as the page shows it: a command an answer beyond the listing says left the queue is gone,
 * whatever that older listing still holds.
 */
export function visibleQueue(state: SessionExecutionState): readonly QueuedCommand[] {
    const { queue } = state;
    if (queue === null) {
        return [];
    }
    return queue.commands.filter((item) => {
        const answered = state.commands.get(item.commandId)?.answer ?? null;
        return answered === null || answered.answer.state === "queued" || !answerBeyond(answered, queue.through);
    });
}

/** Where the page shows a message the Computer accepted: in the queue while it answered so, otherwise as a turn. */
export function acceptedPlacement(state: SessionExecutionState, commandId: string): DeliveryPlacement {
    return commandAnswer(state, commandId)?.state === "queued" ? "queue" : "turn";
}

/**
 * Whether the Computer's own account now shows a message it accepted, so the page no longer needs its copy. A message
 * that runs as a turn is covered once the timeline shows it; history names each turn's command. A queued message keeps
 * its files there until it starts or ends, or a listing that covers its answer no longer holds it. One withdrawn, or
 * steered into the running turn, left the queue for good. One the Computer answers settled ended: if it started, its
 * timeline shows it; if it never started, no account ever will, and the page keeps nothing of it.
 */
export function runtimeCoversMessage(state: SessionExecutionState, commandId: string): boolean {
    const command = state.commands.get(commandId);
    if (command === undefined) {
        return false;
    }
    if (command.shown) {
        return true;
    }
    const answered = command.answer;
    if (answered === null) {
        return false;
    }
    const { queue } = state;
    switch (answered.answer.state) {
        case "withdrawn":
        case "steered":
        case "settled":
            return true;
        case "queued":
            return (
                command.ended ||
                acceptedTurn(state.turn)?.commandId === commandId ||
                (queue !== null &&
                    !answerBeyond(answered, queue.through) &&
                    !queue.commands.some((item) => item.commandId === commandId))
            );
        case "preparing":
        case "running":
            return false;
        default:
            return answered.answer satisfies never;
    }
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

export function submittingCommandId(
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

/**
 * The Session's work as this page accounts for it, including submissions the Computer never saw; none until a pane
 * that started following the Session first reads the Computer's account, as the execution state has nothing of the
 * Computer's before.
 */
export function pageActivity(
    execution: Pick<SessionExecutionState, "coverage" | "turn" | "commands">,
    delivery: DeliveryState,
): SessionActivityState | null {
    return execution.coverage.kind === "unread" ? null : sessionActivity(execution, delivery);
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
