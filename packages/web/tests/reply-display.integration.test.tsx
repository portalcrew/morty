import {
    getAllByRole,
    getByLabelText,
    getByRole,
    getByText,
    queryAllByLabelText,
    queryAllByRole,
    queryAllByText,
    queryByLabelText,
} from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import {
    recoverChat,
    retryOnceComputerReturns,
    sendPrompt,
    showReconnectNotice,
} from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";

const CLOCK_ORIGIN = "2026-10-29T08:00:00Z";

function agentReplies(): HTMLElement[] {
    return queryAllByRole(document.body, "article", { name: "Agent response" });
}

function workingIndicators(app: TestApp): HTMLElement[] {
    return app.elementsByTestId(dataTestId.workingIndicator);
}

async function startToolLifecycle(prompt: string): Promise<TestApp> {
    const app = await createTestApp({
        connectAgent: true,
        agent: { harness: "tool-lifecycle-test", label: "Tool Lifecycle Agent" },
        page: { kind: "bootstrap", identity: true },
    });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), prompt);
    return app;
}

async function startControlled(prompt: string, clock?: TestClock): Promise<TestApp> {
    const app = await createTestApp({ connectAgent: true, ...(clock === undefined ? {} : { clock }) });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), prompt);
    return app;
}

function controlledDaemon(app: TestApp): NonNullable<TestApp["daemon"]> {
    if (app.daemon === null) {
        throw new Error("Expected a controlled Agent Runtime");
    }
    return app.daemon;
}

function toolActivity(title: string) {
    return { kind: "activity", activityType: "tool", content: [], title, output: `${title} output` } as const;
}

async function stopAgent(app: TestApp): Promise<void> {
    await app.user.click(
        await app.queryElementByTestId(
            dataTestId.sendMessage,
            (element) => element.getAttribute("aria-label") === "Stop agent output",
        ),
    );
}

test("Given a turn streams text and several tools, When it completes and the page reloads, Then all of it stays in one Agent response", {
    timeout: 30_000,
}, async () => {
    const app = await startToolLifecycle("answer after verification");
    await app.waitForView(() => {
        expect(getByText(document.body, "Verification finished with one failure.")).toBeDefined();
        expect(agentReplies()).toHaveLength(1);
        expect(getAllByRole(agentReplies()[0] ?? document.body, "button", { name: /^\d+ steps?/u })).toHaveLength(2);
    });

    const reloaded = await app.reload();
    await reloaded.waitForView(() => {
        expect(getByText(document.body, "Verification finished with one failure.")).toBeDefined();
        expect(agentReplies()).toHaveLength(1);
    });
});

// Documents current behavior, not a product decision: a steer message is a user message, so it ends
// the Agent response before it and starts another after it, while the execution stays one.
test("Given a running turn, When the user steers it, Then the steer message sits between two Agent responses and one Working indicator runs the whole execution", {
    timeout: 30_000,
}, async () => {
    const app = await startToolLifecycle("answer then hold");
    await app.waitForView(() => {
        expect(getByText(document.body, "Partial answer before stopping.")).toBeDefined();
        expect(agentReplies()).toHaveLength(1);
        expect(workingIndicators(app)).toHaveLength(1);
    });

    const instruction = "Also check the notes";
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), instruction);
    const queued = await app.queryElementByTestId(
        dataTestId.queuedMessage,
        (element) => element.textContent?.includes(instruction) === true,
    );
    await app.user.click(getByLabelText(queued, `Steer queued message: ${instruction}`));

    await app.waitForView(() => {
        const replies = agentReplies();
        expect(replies).toHaveLength(2);
        const steer = app
            .elementsByTestId(dataTestId.userMessage)
            .find((element) => element.textContent?.includes(instruction));
        if (steer === undefined) {
            throw new Error("Expected the steer message in the timeline");
        }
        expect(replies[0]?.compareDocumentPosition(steer)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
        expect(steer.compareDocumentPosition(replies[1] ?? steer)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
        expect(workingIndicators(app)).toHaveLength(1);
    });

    await stopAgent(app);
    await app.waitForView(() => {
        expect(app.elementByTestId(dataTestId.agentReplyStatus).textContent).toBe("Turn stopped.");
        expect(workingIndicators(app)).toHaveLength(0);
    });
});

test("Given a tool starts and is later updated, When the turn completes, Then the segment counts one step with one tool row", {
    timeout: 30_000,
}, async () => {
    const app = await startToolLifecycle("update one tool in place");
    const summary = await app.waitForView(() => {
        expect(getByText(document.body, "The updated tool finished.")).toBeDefined();
        return getByRole(document.body, "button", { name: "1 step", expanded: false });
    });
    await app.user.click(summary);
    await app.waitForView(() => {
        const rows = queryAllByLabelText(document.body, "Tool: Updated verification");
        expect(rows).toHaveLength(1);
        // The in-progress call settled through its update instead of staying running.
        expect(queryAllByLabelText(rows[0] ?? document.body, "Tool succeeded")).toHaveLength(1);
        expect(queryAllByLabelText(rows[0] ?? document.body, "Tool running")).toHaveLength(0);
    });
});

test("Given tools run on either side of a context compaction, When the turn completes, Then the compaction stays between two separate process segments", {
    timeout: 30_000,
}, async () => {
    const app = await startControlled("hold after first delta");
    await app.waitForView(() => getByText(document.body, "Partial reply"));
    await controlledDaemon(app).continueReply("hold after first delta", {
        outcome: "complete",
        output: [
            toolActivity("Before compaction"),
            { kind: "compaction", summary: "The earlier work was summarized." },
            toolActivity("After compaction"),
            { kind: "text", text: "Answer after compaction." },
        ],
    });

    await app.waitForView(() => {
        expect(getByText(document.body, "Answer after compaction.")).toBeDefined();
        const summaries = getAllByRole(document.body, "button", { name: "1 step" });
        expect(summaries).toHaveLength(2);
        const compaction = app.elementByTestId(dataTestId.agentCompaction);
        expect(summaries[0]?.compareDocumentPosition(compaction)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
        expect(compaction.compareDocumentPosition(summaries[1] ?? compaction)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
        expect(summaries[0]?.contains(compaction)).toBe(false);
        expect(summaries[1]?.contains(compaction)).toBe(false);
        expect(agentReplies()).toHaveLength(1);
    });
});

test("Given the agent asks for permission mid-turn, When the request is waiting, Then Chat shows no Working indicator", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        connectAgent: true,
        agent: { harness: "interaction-test", label: "Interaction Agent" },
    });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "request user input");
    await app.waitForView(() => getByRole(document.body, "alertdialog", { name: "Agent permission request" }));
    expect(workingIndicators(app)).toHaveLength(0);
});

// A regression guard: the process summary has no status default today, so an explicit expansion
// survives trivially. It must keep surviving if one is ever added.
test("Given a user expands the process summary while the turn runs, When more tools arrive and the turn completes, Then the explicit expansion survives", {
    timeout: 30_000,
}, async () => {
    const app = await startControlled("hold after first delta");
    const daemon = controlledDaemon(app);
    await app.waitForView(() => getByText(document.body, "Partial reply"));
    await daemon.continueReply("hold after first delta", { outcome: "hold", output: [toolActivity("First tool")] });
    const summary = await app.waitForView(() =>
        getByRole(document.body, "button", { name: "1 step", expanded: false }),
    );
    await app.user.click(summary);
    await app.waitForView(() => expect(queryByLabelText(document.body, "Tool: First tool")).not.toBeNull());

    await daemon.continueReply("hold after first delta", { outcome: "hold", output: [toolActivity("Second tool")] });
    await app.waitForView(() => {
        expect(getByRole(document.body, "button", { name: "2 steps", expanded: true })).toBeDefined();
        expect(queryByLabelText(document.body, "Tool: First tool")).not.toBeNull();
        expect(queryByLabelText(document.body, "Tool: Second tool")).not.toBeNull();
    });

    await daemon.continueReply("hold after first delta", {
        outcome: "complete",
        output: [{ kind: "text", text: "Answer once the tools are done." }],
    });
    await app.waitForView(() => {
        expect(getByText(document.body, "Answer once the tools are done.")).toBeDefined();
        expect(getByRole(document.body, "button", { name: "2 steps", expanded: true })).toBeDefined();
        expect(workingIndicators(app)).toHaveLength(0);
    });
});

// The step counts come from the four tools the "fail unfinished tools" scenario emits:
// completed, failed, in progress and pending, the last two interrupted by the failure.
test("Given tools were unfinished when the turn fails, When the failure arrives, Then the process stays behind its summary beside the failure card", {
    timeout: 30_000,
}, async () => {
    const app = await startToolLifecycle("fail unfinished tools");
    const summary = await app.waitForView(() => {
        expect(getByText(document.body, "Response failed")).toBeDefined();
        expect(workingIndicators(app)).toHaveLength(0);
        return getByRole(document.body, "button", { name: "4 steps · 2 interrupted", expanded: false });
    });
    await app.user.click(summary);
    await app.waitForView(() => {
        expect(queryByLabelText(document.body, "Tool: Completed verification")).not.toBeNull();
        expect(queryByLabelText(document.body, "Tool: Failed verification")).not.toBeNull();
        expect(getByText(document.body, "Response failed")).toBeDefined();
    });
});

test("Given a reply is streaming, When Chat loses its connection and recovers, Then the partial reply is not repeated and the finished reply joins the same Agent response", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock(CLOCK_ORIGIN);
    const app = await startControlled("hold after first delta", clock);
    const daemon = controlledDaemon(app);
    await app.waitForView(() =>
        expect(queryAllByText(document.body, "Partial reply", { exact: true })).toHaveLength(1),
    );

    await act(async () => {
        app.transport.disconnect();
        await daemon.continueReply("hold after first delta", {
            outcome: "complete",
            output: [{ kind: "text", text: "Finished during the interruption." }],
        });
    });
    expect(queryAllByText(document.body, "Partial reply", { exact: true })).toHaveLength(1);
    await recoverChat(app, clock);

    await app.waitForView(() => {
        expect(getByText(document.body, "Finished during the interruption.")).toBeDefined();
        expect(queryAllByText(document.body, "Partial reply", { exact: true })).toHaveLength(1);
        expect(queryAllByText(document.body, "Finished during the interruption.", { exact: true })).toHaveLength(1);
        expect(agentReplies()).toHaveLength(1);
        expect(workingIndicators(app)).toHaveLength(0);
    });
});

test("Given a reply is streaming, When the Computer restarts, Then the partial reply stays once and the turn is reported as failed rather than complete", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock(CLOCK_ORIGIN);
    const app = await startControlled("hold after first delta", clock);
    const daemon = controlledDaemon(app);
    await app.waitForView(() =>
        expect(queryAllByText(document.body, "Partial reply", { exact: true })).toHaveLength(1),
    );

    await daemon.disconnect();
    await showReconnectNotice(app, clock);
    await daemon.reconnect();
    await retryOnceComputerReturns(app);

    await app.waitForView(() => {
        expect(getByRole(document.body, "alert").textContent).toContain(
            "The local runtime restarted while this request was running",
        );
        expect(queryAllByText(document.body, "Partial reply", { exact: true })).toHaveLength(1);
        expect(agentReplies()).toHaveLength(1);
        expect(workingIndicators(app)).toHaveLength(0);
    });
});
