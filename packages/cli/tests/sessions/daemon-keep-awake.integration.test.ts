import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeSessionEventEnvelope,
    decodeSessionPermissionRequestedEvent,
    encodeSessionPermissionRespondCommand,
    encodeSessionPromptCommand,
    type NativeSessionTarget,
    SESSION_EVENT_KIND,
    SESSION_PERMISSION_REQUESTED_KIND,
    type SessionLiveEvent,
    type SessionPermissionRequestedEvent,
    SessionPromptDisposition,
} from "@portalcrew/morty-client/protocol";
import { expect, test } from "vitest";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import {
    type DaemonConnectionPeer,
    prepareNewRealSession,
    withControlledDaemonConnection,
} from "../support/agents/real-daemon.ts";
import { writeControlledAcpExecutable } from "../support/controlled-acp-executable.ts";
import { RecordingSleepPrevention } from "../support/recording-sleep-prevention.ts";

const submit = (peer: DaemonConnectionPeer, target: NativeSessionTarget, prompt: string): string => {
    const commandId = randomUUID();
    peer.send(
        encodeSessionPromptCommand({
            attachments: [],
            commandId,
            requestId: commandId,
            disposition: SessionPromptDisposition.Append,
            kind: "session.prompt",
            prompt,
            target,
        }),
    );
    return commandId;
};

const cancel = (peer: DaemonConnectionPeer, target: NativeSessionTarget, commandId: string): void =>
    peer.send(JSON.stringify({ kind: "session.cancel", requestId: randomUUID(), commandId, target }));

const observe = (peer: DaemonConnectionPeer) => {
    const events: SessionLiveEvent[] = [];
    const permissions: SessionPermissionRequestedEvent[] = [];
    const next = async (): Promise<void> => {
        const message = await peer.nextMessage();
        if (decodeMessageKind(message) !== SESSION_EVENT_KIND) {
            return;
        }
        for (const event of decodeSessionEventEnvelope(message).events) {
            events.push(event);
            if (event.type === "lifecycle-metadata" && "event" in event.payload) {
                const interaction = JSON.stringify(event.payload.event);
                if (decodeMessageKind(interaction) === SESSION_PERMISSION_REQUESTED_KIND) {
                    permissions.push(decodeSessionPermissionRequestedEvent(interaction));
                }
            }
        }
    };
    const lifecycle = async (kinds: readonly string[], commandId: string): Promise<void> => {
        while (
            !events.some(
                (event) =>
                    event.type === "lifecycle-metadata" &&
                    kinds.includes(event.payload.kind) &&
                    "commandId" in event.payload &&
                    event.payload.commandId === commandId,
            )
        ) {
            await next();
        }
    };
    return {
        started: (commandId: string) => lifecycle(["prompt.started"], commandId),
        ended: (commandId: string) =>
            lifecycle(["prompt.completed", "prompt.failed", "prompt.failed-before-start"], commandId),
        permission: async (): Promise<SessionPermissionRequestedEvent> => {
            for (;;) {
                const permission = permissions.shift();
                if (permission !== undefined) {
                    return permission;
                }
                await next();
            }
        },
    };
};

const scenario = async (
    signal: AbortSignal,
    run: (peer: DaemonConnectionPeer, computer: RecordingSleepPrevention, agentState: string) => Promise<void>,
): Promise<void> => {
    const directory = await mkdtemp(join(tmpdir(), "morty-keep-awake-"));
    const agentState = join(directory, "agent");
    const computer = new RecordingSleepPrevention();
    try {
        await withControlledDaemonConnection(
            signal,
            new ControlledAcpAgentSpecification(),
            {
                MORTY_FAKE_ACP_STATE_DIRECTORY: agentState,
                PATH: await writeControlledAcpExecutable(directory),
            },
            (peer) => run(peer, computer, agentState),
            "embedded",
            computer,
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
};

test("Given an Agent works on a prompt, When the turn ends, Then the computer stays awake through the turn and may sleep afterwards", async ({
    signal,
}) => {
    await scenario(signal, async (peer, computer, agentState) => {
        const target = await prepareNewRealSession(peer, "controlled-acp");
        const observed = observe(peer);
        expect(computer.awake).toBe(false);

        const turn = submit(peer, target, "release after first delta");
        await observed.started(turn);
        expect(computer.awake).toBe(true);

        await writeFile(join(agentState, "resume-turn"), "");
        await observed.ended(turn);
        await computer.asleep();
        expect(computer.holds).toBe(1);
    });
});

test("Given an Agent waits for a permission answer, When the person answers from another device, Then the computer stays awake while it waits and may sleep once the turn ends", async ({
    signal,
}) => {
    await scenario(signal, async (peer, computer) => {
        const target = await prepareNewRealSession(peer, "controlled-acp");
        const observed = observe(peer);

        const turn = submit(peer, target, "request permission for an announced tool call");
        const permission = await observed.permission();
        expect(computer.awake).toBe(true);

        peer.send(
            encodeSessionPermissionRespondCommand({
                interactionId: permission.interactionId,
                kind: "session.permission.respond",
                requestId: randomUUID(),
                optionId: "allow-once",
                outcome: "selected",
                target,
            }),
        );
        await observed.ended(turn);
        await computer.asleep();
        expect(computer.holds).toBe(1);
    });
});

test("Given two Sessions work at once, When one Session's turn ends, Then the computer stays awake for the other and may sleep once both end", async ({
    signal,
}) => {
    await scenario(signal, async (peer, computer) => {
        const first = await prepareNewRealSession(peer, "controlled-acp");
        const second = await prepareNewRealSession(peer, "controlled-acp");
        const observed = observe(peer);

        const longTurn = submit(peer, first, "hold after first delta");
        await observed.started(longTurn);
        const shortTurn = submit(peer, second, "Short task");
        await observed.ended(shortTurn);
        // The next prompt starts only after the short turn has finished, so the Runtime has stopped counting it.
        const nextTurn = submit(peer, second, "Next short task");
        await observed.started(nextTurn);
        expect(computer.awake).toBe(true);
        expect(computer.holds).toBe(1);

        await observed.ended(nextTurn);
        cancel(peer, first, longTurn);
        await observed.ended(longTurn);
        await computer.asleep();
        expect(computer.holds).toBe(1);
    });
});

test("Given an Agent works on a prompt, When the person stops the turn, Then the computer may sleep", async ({
    signal,
}) => {
    await scenario(signal, async (peer, computer) => {
        const target = await prepareNewRealSession(peer, "controlled-acp");
        const observed = observe(peer);

        const turn = submit(peer, target, "hold after first delta");
        await observed.started(turn);
        expect(computer.awake).toBe(true);

        cancel(peer, target, turn);
        await observed.ended(turn);
        await computer.asleep();
        expect(computer.holds).toBe(1);
    });
});

test("Given an Agent works on a prompt, When Morty stops on this computer, Then the computer may sleep", async ({
    signal,
}) => {
    await scenario(signal, async (peer, computer) => {
        const target = await prepareNewRealSession(peer, "controlled-acp");
        const observed = observe(peer);

        const turn = submit(peer, target, "hold after first delta");
        await observed.started(turn);
        expect(computer.awake).toBe(true);

        await peer.restart();
        expect(computer.awake).toBe(false);
        expect(computer.holds).toBe(1);
    });
});
