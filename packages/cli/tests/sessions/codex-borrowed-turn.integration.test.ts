import { afterEach, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "../../src/engine/acp/harness/codex/app-server-client.ts";
import { CodexBorrowedAcpAgent } from "../../src/engine/acp/harness/codex/borrowed-agent.ts";

afterEach(() => {
    vi.useRealTimers();
});

it("Given another Codex client owns the thread, When its turn for this prompt is still running, Then the prompt ends only after the owner completes it", async ({
    signal,
}) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T00:00:00.000Z"));
    // Codex reports the owner's unfinished turn to a reader as "interrupted" without a completion time.
    let ownerTurn: { readonly status: string; readonly completedAt?: number } | null = null;
    let clientId = "";
    const client = {
        request: async (method: string, params: Record<string, unknown>): Promise<unknown> => {
            switch (method) {
                case "thread/queue/list":
                    return { data: [], nextCursor: null };
                case "thread/queue/add":
                    clientId = String(params["clientUserMessageId"]);
                    return { queuedSubmission: { id: "queued", clientUserMessageId: clientId } };
                case "thread/turns/list":
                    return {
                        data:
                            ownerTurn === null
                                ? []
                                : [
                                      {
                                          id: "owner-turn",
                                          ...ownerTurn,
                                          items: [
                                              {
                                                  type: "userMessage",
                                                  id: "user",
                                                  clientId,
                                                  content: [{ type: "text", text: "Plan it" }],
                                              },
                                          ],
                                      },
                                  ],
                        nextCursor: null,
                    };
                default:
                    throw new Error(`Unexpected Codex request ${method}`);
            }
        },
    } as unknown as CodexAppServerClient;
    const agent = new CodexBorrowedAcpAgent(
        client,
        "thread",
        async () => {},
        async () => {},
        async () => null,
    );
    await agent.initialize(signal);

    let settled = false;
    const prompt = agent
        .prompt([{ type: "text", text: "Plan it" }], signal, [{ type: "text", text: "Plan it" }])
        .finally(() => {
            settled = true;
        });
    await vi.advanceTimersByTimeAsync(0);
    ownerTurn = { status: "interrupted" };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);

    ownerTurn = { status: "completed", completedAt: Date.now() };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await prompt).toMatchObject({ stopReason: "end_turn" });
    await agent.close();
});

function answeringOwner() {
    const owner = { answered: false, stallNextRead: false, stalledReads: 0, clientId: "" };
    const client = {
        request: async (method: string, params: Record<string, unknown>): Promise<unknown> => {
            switch (method) {
                case "thread/queue/list":
                    return { data: [], nextCursor: null };
                case "thread/queue/add":
                    owner.clientId = String(params["clientUserMessageId"]);
                    return { queuedSubmission: { id: "queued", clientUserMessageId: owner.clientId } };
                case "thread/turns/list":
                    if (owner.stallNextRead) {
                        owner.stallNextRead = false;
                        owner.stalledReads += 1;
                        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
                    }
                    return {
                        data: owner.answered
                            ? [
                                  {
                                      id: "owner-turn",
                                      status: "completed",
                                      completedAt: Date.now(),
                                      items: [
                                          {
                                              type: "userMessage",
                                              id: "user",
                                              clientId: owner.clientId,
                                              content: [{ type: "text", text: "Plan it" }],
                                          },
                                          { type: "agentMessage", id: "answer", text: "Planned" },
                                      ],
                                  },
                              ]
                            : [],
                        nextCursor: null,
                    };
                default:
                    throw new Error(`Unexpected Codex request ${method}`);
            }
        },
    } as unknown as CodexAppServerClient;
    return { owner, client };
}

it("Given a queued prompt in a borrowed Codex thread, When one history read times out, Then the owner's answer still completes the prompt", async ({
    signal,
}) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-04T00:00:00.000Z"));
    const { owner, client } = answeringOwner();
    const answers: string[] = [];
    const agent = new CodexBorrowedAcpAgent(
        client,
        "thread",
        async (update) => {
            if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
                answers.push(update.content.text);
            }
        },
        async () => {},
        async () => null,
    );
    await agent.initialize(signal);

    owner.stallNextRead = true;
    const prompt = agent.prompt([{ type: "text", text: "Plan it" }], signal, [{ type: "text", text: "Plan it" }]);
    void prompt.catch(() => {});
    await vi.advanceTimersByTimeAsync(1_000);
    expect(owner.stalledReads).toBe(1);

    owner.answered = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await prompt).toMatchObject({ stopReason: "end_turn" });
    expect(answers).toEqual(["Planned"]);
    await agent.close();
});

it("Given a queued prompt in a borrowed Codex thread, When delivering the owner's answer times out, Then the prompt fails", async ({
    signal,
}) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-04T00:00:00.000Z"));
    const { owner, client } = answeringOwner();
    const agent = new CodexBorrowedAcpAgent(
        client,
        "thread",
        async (update) => {
            if (update.sessionUpdate === "agent_message_chunk") {
                throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
            }
        },
        async () => {},
        async () => null,
    );
    await agent.initialize(signal);

    const prompt = agent.prompt([{ type: "text", text: "Plan it" }], signal, [{ type: "text", text: "Plan it" }]);
    const failed = expect(prompt).rejects.toThrow("The owning Codex session could not be followed");
    owner.answered = true;
    await vi.advanceTimersByTimeAsync(2_000);
    await failed;
    await agent.close();
});
