import type { MortyClient } from "@morty-build/client";
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

// What the page knows about one Session's execution: the current turn, the Computer's queue, the Agent's pending
// requests, and what the Computer has shown of each command. Every fact about the execution, a live lifecycle event, an
// execution read, the service's acceptance of a submission, enters through `applyExecutionFact`, and only there is it
// decided whether a fact is newer than what the state already holds. The page keeps this state for the Session, so it
// outlives the pane that follows the Session; the pane feeds facts in and performs the reads the transitions ask for.

/** The Computer's account of the Session's execution, as one read returns it. */
type SessionExecutionSnapshot = Awaited<ReturnType<MortyClient["sessions"]["readSessionExecution"]>>;

/** A message the Computer holds queued behind the running turn. */
export type QueuedCommand = SessionExecutionSnapshot["queued"][number];

/** A point of the Session's execution log: its generation, and a position that only grows within it. */
type LogPosition = SessionExecutionSnapshot["executionPosition"];

/** How a turn's live lifecycle says it ended. */
type TurnOutcome =
    | { readonly kind: "completed" }
    /** Steering ended the turn, but its execution goes on; only a read tells what runs now. */
    | { readonly kind: "steered" }
    | { readonly kind: "failed"; readonly failure: TurnFailure };

/** A lifecycle fact that changes the Agent's pending requests. */
type InteractionChange = Extract<
    SessionLifecycleFact,
    { readonly kind: "interaction-requested" | "permission-resolved" | "elicitation-resolved" }
>;

/** What a lifecycle event says about the Session's execution. */
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
    /** The Computer handed the command to the native session's owner, which reached `stage` with it at `at`. */
    | {
          readonly kind: "turn-delegated";
          readonly commandId: string;
          readonly stage: DelegationStage;
          readonly at: number;
      }
    | { readonly kind: "turn-ended"; readonly commandId: string; readonly outcome: TurnOutcome };

/** A lifecycle event at `position` of the Session's log. */
type LiveExecutionFact = {
    readonly kind: "live";
    readonly sessionGenerationId: string;
    readonly position: string;
    readonly change: LiveExecutionChange;
};

export type SessionExecutionFact =
    /**
     * A pane starts following the Session, opened while `running` ran, or nothing. Until the pane's first read, the
     * queue and requests this page last saw may be out of date, and nothing orders live facts.
     */
    | {
          readonly kind: "opened";
          readonly running: { readonly commandId: string; readonly turnId: string } | null;
          readonly openedAt: number;
      }
    | LiveExecutionFact
    /**
     * The Computer's account of the execution through `snapshot.executionPosition`, for a read that began when the
     * state's `executionReadBasis` was `basis`. `deliveryCommandId` names the command whose delivery the read asked for;
     * `readAt`, when it returned, dates a running turn whose Computer does not report its start.
     */
    | {
          readonly kind: "read";
          readonly snapshot: SessionExecutionSnapshot;
          readonly basis: number;
          readonly deliveryCommandId: string | null;
          readonly readAt: number;
      }
    /**
     * The service accepted this page's submission of `commandId`, to run now or queued, sent at `startedAt`. An HTTP
     * answer has no position in the Session's log.
     */
    | {
          readonly kind: "acknowledged";
          readonly commandId: string;
          readonly turnId: string;
          readonly queued: boolean;
          readonly startedAt: number;
      }
    /** This page submits a new turn, so the failure reported for an earlier one no longer describes the Session. */
    | { readonly kind: "turn-submitted" }
    /** The pane's timeline shows the `shown` commands' own messages; its history records the `recorded` commands. */
    | { readonly kind: "history"; readonly shown: readonly string[]; readonly recorded: readonly string[] }
    /** The Computer closed the Session, which runs and queues nothing and asks nothing of the user. */
    | { readonly kind: "closed" };

/** What the Computer has shown this page about one of the Session's commands. */
interface RuntimeCommand {
    /**
     * When this page learned the Computer holds the command: how many commands it had learned of before. Commands are
     * never forgotten, so this orders them in the order they were learned.
     */
    readonly learnedAt: number;
    /** The timeline showed the command's own message. */
    readonly shown: boolean;
    /** The Computer reported the command's turn ended. */
    readonly ended: boolean;
}

/** How far the state reflects the Session's execution log. */
type ExecutionCoverage =
    /**
     * No read since the pane started following the Session. The first read is the baseline, and the live facts that
     * arrive meanwhile wait: it covers only those up to its position.
     */
    | { readonly kind: "unread"; readonly held: readonly LiveExecutionFact[] }
    | { readonly kind: "covered"; readonly position: LogPosition }
    /**
     * A live fact came from another generation of the log than `position`. The read it asked for decides on it and
     * on the facts that arrived after it.
     */
    | { readonly kind: "awaiting-read"; readonly position: LogPosition; readonly held: readonly LiveExecutionFact[] };

export interface SessionExecutionState {
    readonly coverage: ExecutionCoverage;
    readonly turn: CurrentTurn;
    /** The messages the Computer holds queued, as last observed. */
    readonly queued: readonly QueuedCommand[];
    /** The queue the last applied read listed, and the `basis` it began with: what it could not have seen. */
    readonly listing: { readonly queued: ReadonlySet<string>; readonly basis: number } | null;
    /** The Agent's requests in arrival order, each with its latest resolution. */
    readonly interactions: readonly SessionInteraction[];
    readonly commands: ReadonlyMap<string, RuntimeCommand>;
}

type SessionExecutionEffect =
    /** The state needs a fresh read of the Computer's execution before it is current again. */
    | { readonly kind: "read" }
    /** The Computer reported what runs and what is queued; the timeline marks it at this point. */
    | { readonly kind: "mark-timeline"; readonly running: string | null; readonly queued: readonly string[] };

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
};

const readEffect: SessionExecutionEffect = { kind: "read" };

function settled(state: SessionExecutionState): SessionExecutionTransition {
    return { state, effects: [] };
}

/** Records that the Computer holds `commandIds`, and that it showed or ended them. */
function learn(
    state: SessionExecutionState,
    commandIds: readonly string[],
    fact: "holds" | "shows" | "ended",
): SessionExecutionState {
    let commands: Map<string, RuntimeCommand> | null = null;
    for (const commandId of commandIds) {
        const current = commands ?? state.commands;
        const known = current.get(commandId);
        const base = known ?? { learnedAt: current.size, shown: false, ended: false };
        const next = fact === "shows" ? { ...base, shown: true } : fact === "ended" ? { ...base, ended: true } : base;
        if (known !== undefined && next.shown === known.shown && next.ended === known.ended) {
            continue;
        }
        commands ??= new Map(state.commands);
        commands.set(commandId, next);
    }
    return commands === null ? state : { ...state, commands };
}

function commandEnded(state: Pick<SessionExecutionState, "commands">, commandId: string): boolean {
    return state.commands.get(commandId)?.ended === true;
}

/** The turn id of a command the service reports running: the one it accepted this page's submission under, if any. */
function runningTurnId(turn: CurrentTurn, commandId: string): string {
    const accepted = acceptedTurn(turn);
    return accepted?.commandId === commandId ? accepted.turnId : commandId;
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

/** Applies what a live fact says, once it is known to be newer than what the state holds. */
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
                          turnId: runningTurnId(known.turn, commandId),
                          startedAt,
                          observedAt: startedAt,
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

/** Applies a live fact against the position the state covers: an older one is already reflected. */
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

/** Decides the live facts a read was awaited for: those of another generation than the read's are dropped. */
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
    const { snapshot, basis, deliveryCommandId, readAt } = fact;
    const { coverage } = state;
    const position = snapshot.executionPosition;
    const held = coverage.kind === "covered" ? [] : coverage.held;
    if (
        coverage.kind !== "unread" &&
        coverage.position.sessionGenerationId === position.sessionGenerationId &&
        BigInt(position.throughPosition) < BigInt(coverage.position.throughPosition)
    ) {
        // The state already reflects facts newer than this read.
        return replayHeld(settled({ ...state, coverage: { kind: "covered", position: coverage.position } }), held);
    }
    const running = snapshot.turn;
    // Only the Computer knows whether a submission arrived, including one that finished while no pane followed the
    // Session. A Computer or Relay that cannot report it omits the delivery, and the submission stays unconfirmed. The
    // execution receipt of a running command confirms its delivery even when admission and live events were lost.
    let next = learn(
        state,
        [
            ...snapshot.queued.map((item) => item.commandId),
            ...(deliveryCommandId !== null && snapshot.command !== undefined && snapshot.command.state !== "unknown"
                ? [deliveryCommandId]
                : []),
            ...(running === null ? [] : [running.commandId]),
        ],
        "holds",
    );
    let turn = next.turn;
    if (running !== null) {
        turn = transitionCurrentTurn(turn, {
            kind: "running",
            commandId: running.commandId,
            turnId: runningTurnId(turn, running.commandId),
            startedAt: Date.parse(running.startedAt),
            observedAt: readAt,
        });
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
                interactions:
                    snapshot.interactionState === null
                        ? []
                        : snapshot.interactionState.interactions.map(requestedInteraction),
            },
            effects: [{ kind: "mark-timeline", running: running?.commandId ?? null, queued }],
        },
        held,
    );
}

/** Moves the Session's execution state by one fact, and says what the fact asks of the pane following the Session. */
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
            const { running } = fact;
            if (running === null) {
                return settled({ ...opened, turn: transitionCurrentTurn(opened.turn, { kind: "nothing-running" }) });
            }
            const known = learn(opened, [running.commandId], "holds");
            return settled({
                ...known,
                turn: transitionCurrentTurn(known.turn, {
                    kind: "running",
                    commandId: running.commandId,
                    turnId: running.turnId,
                    startedAt: null,
                    observedAt: fact.openedAt,
                }),
            });
        }
        case "live":
            return applyLive(state, fact);
        case "read":
            return applyRead(state, fact);
        case "acknowledged": {
            const known = learn(state, [fact.commandId], "holds");
            // A queued message starts no turn yet, and a terminal live event can precede the acceptance response: the
            // turn it ended stays ended.
            if (fact.queued || commandEnded(state, fact.commandId)) {
                return settled(known);
            }
            return settled({
                ...known,
                turn: transitionCurrentTurn(known.turn, {
                    kind: "accepted",
                    commandId: fact.commandId,
                    turnId: fact.turnId,
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
                },
                effects: [{ kind: "mark-timeline", running: null, queued: [] }],
            };
        default:
            return fact satisfies never;
    }
}

/** What a read that begins now passes back as its `basis`: the commands it can know of are those learned before. */
export function executionReadBasis(state: SessionExecutionState): number {
    return state.commands.size;
}

/** Whether the Computer has shown it holds the command: listed, running, ended, recorded or confirmed by a receipt. */
export function runtimeHoldsCommand(state: SessionExecutionState, commandId: string): boolean {
    return state.commands.has(commandId);
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
    if (message.placement === "turn") {
        return false;
    }
    return (
        acceptedTurn(state.turn)?.commandId === message.commandId ||
        (state.listing !== null &&
            command.learnedAt < state.listing.basis &&
            !state.listing.queued.has(message.commandId))
    );
}

/** The questions the Agent asks that are still pending. */
export function pendingQuestionIds(interactions: readonly SessionInteraction[]): ReadonlySet<string> {
    return new Set(
        interactions.flatMap((interaction) =>
            interaction.kind === "elicitation" && interaction.elicitation.state.kind === "pending"
                ? [interaction.elicitation.interactionId]
                : [],
        ),
    );
}

/** Whether the Agent waits for the user to answer one of its requests. */
export function waitingForInput(interactions: readonly SessionInteraction[]): boolean {
    return interactions.some(
        (interaction) =>
            (interaction.kind === "permission" && interaction.permission.state.kind !== "resolved") ||
            (interaction.kind === "elicitation" &&
                (interaction.elicitation.state.kind === "pending" ||
                    interaction.elicitation.state.kind === "submitted")),
    );
}

/**
 * The command of the new turn this page is submitting and the service has not reported yet: a message sent as a new
 * turn while its delivery is being prepared or submitted. A message queued behind a running turn starts none, and
 * once the service reports the command running or ended, the turn is the service's account.
 */
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

/** The Session's execution state on this page, which only `apply` moves. */
export interface SessionExecutionStore {
    readonly state: SessionExecutionState;
    /** Applies one fact and returns what it asks of the pane following the Session. */
    readonly apply: (fact: SessionExecutionFact) => readonly SessionExecutionEffect[];
}

export function createSessionExecutionStore(ports: {
    /** The state moved, which what the page derives from the Computer's account follows. */
    readonly changed: (previous: SessionExecutionState, next: SessionExecutionState) => void;
}) {
    return createStore<SessionExecutionStore>()((set, get) => ({
        state: initialSessionExecution,
        apply: (fact) => {
            const previous = get().state;
            const { state, effects } = applyExecutionFact(previous, fact);
            if (state !== previous) {
                set({ state });
                ports.changed(previous, state);
            }
            return effects;
        },
    }));
}

/** The execution of no Session, for a view that follows the open Session's execution when none is open. */
export const noSessionExecution = createStore<Pick<SessionExecutionStore, "state">>()(() => ({
    state: initialSessionExecution,
}));
