import * as acp from "@agentclientprotocol/sdk/unstable";
import { waitForFile } from "../../support/acp-process.ts";

export async function runInteractionScenario(
    context: acp.AgentRequestContext<acp.PromptRequest>,
    prompt: string,
    turnNumber: number,
    cancellation: AbortController,
): Promise<{ readonly stopReason: "cancelled" } | { readonly branch: string }> {
    let selectedBranch = "";
    if (prompt === "exercise ACP controls") {
        const permission = await context.client.request(acp.methods.client.session.requestPermission, {
            options: [
                {
                    kind: "allow_once",
                    name: "Allow once",
                    optionId: "allow-once",
                },
                {
                    kind: "reject_once",
                    name: "Reject",
                    optionId: "reject",
                },
            ],
            sessionId: context.params.sessionId,
            toolCall: {
                kind: "execute",
                status: "pending",
                title: "Run the verification command",
                toolCallId: "permission-tool",
                rawInput: { command: "pnpm test -- --reporter=verbose", target: "src/<entry>.ts" },
                locations: [{ path: "src/<entry>.ts", line: 12 }],
            },
        });
        if (permission.outcome.outcome !== "selected") {
            return { stopReason: "cancelled" };
        }
        if (process.env["MORTY_FAKE_ACP_PAUSE_AFTER_PERMISSION"] === "1") {
            const directory = process.env["MORTY_FAKE_ACP_STATE_DIRECTORY"];
            if (directory === undefined) {
                throw new Error("The controlled Agent state directory is unavailable");
            }
            await waitForFile(directory, "resume-after-permission", cancellation.signal);
            if (cancellation.signal.aborted) {
                return { stopReason: "cancelled" };
            }
        }

        const elicitation = await context.client.request(acp.methods.client.elicitation.create, {
            message: "Choose the branch to verify",
            mode: "form",
            requestedSchema: {
                properties: {
                    branch: {
                        description: "Git branch name",
                        minLength: 1,
                        title: "Branch",
                        type: "string",
                    },
                },
                required: ["branch"],
                type: "object",
            },
            sessionId: context.params.sessionId,
        });
        if (elicitation.action !== "accept") {
            return { stopReason: "cancelled" };
        }
        const branch =
            typeof elicitation.content === "object" &&
            elicitation.content !== null &&
            !Array.isArray(elicitation.content)
                ? Reflect.get(elicitation.content, "branch")
                : undefined;
        selectedBranch = typeof branch === "string" ? branch : "";
        if (process.env["MORTY_FAKE_ACP_PAUSE_AFTER_ELICITATION"] === "1") {
            const directory = process.env["MORTY_FAKE_ACP_STATE_DIRECTORY"];
            if (directory === undefined) {
                throw new Error("The controlled Agent state directory is unavailable");
            }
            await waitForFile(directory, "resume-after-elicitation", cancellation.signal);
            if (cancellation.signal.aborted) {
                return { stopReason: "cancelled" };
            }
        }

        await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
                content: {
                    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                    mimeType: "image/png",
                    type: "image",
                },
                messageId: `image-${turnNumber.toString()}`,
                sessionUpdate: "agent_message_chunk",
            },
        });
    }
    if (prompt === "request permission for an announced tool call") {
        // ACP permission requests carry a ToolCallUpdate: fields it omits are
        // inherited from the tool call that was already announced.
        await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
                kind: "execute",
                locations: [{ path: "scripts/release.sh", line: 3 }],
                rawInput: { command: "sh scripts/release.sh --publish" },
                sessionUpdate: "tool_call",
                status: "pending",
                title: "Release the package",
                toolCallId: "announced-tool",
            },
        });
        const permission = await context.client.request(acp.methods.client.session.requestPermission, {
            options: [
                { kind: "allow_once", name: "Allow once", optionId: "allow-once" },
                { kind: "reject_once", name: "Reject", optionId: "reject" },
            ],
            sessionId: context.params.sessionId,
            toolCall: { title: "Approve the release command", toolCallId: "announced-tool" },
        });
        if (permission.outcome.outcome !== "selected") {
            return { stopReason: "cancelled" };
        }
    }
    if (prompt === "request permission after a null rawInput update") {
        // ACP v1: on a tool call update, omission and null are equivalent for
        // rawInput and both leave the previously reported value unchanged.
        await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
                kind: "execute",
                locations: [{ path: "scripts/release.sh", line: 3 }],
                rawInput: { command: "sh scripts/release.sh --publish" },
                sessionUpdate: "tool_call",
                status: "pending",
                title: "Release the package",
                toolCallId: "null-input-tool",
            },
        });
        await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
                rawInput: null,
                sessionUpdate: "tool_call_update",
                status: "in_progress",
                toolCallId: "null-input-tool",
            },
        });
        const permission = await context.client.request(acp.methods.client.session.requestPermission, {
            options: [
                { kind: "allow_once", name: "Allow once", optionId: "allow-once" },
                { kind: "reject_once", name: "Reject", optionId: "reject" },
            ],
            sessionId: context.params.sessionId,
            toolCall: { title: "Approve the release command", toolCallId: "null-input-tool" },
        });
        if (permission.outcome.outcome !== "selected") {
            return { stopReason: "cancelled" };
        }
    }
    if (prompt === "request permission for an orphan update announcement") {
        // A tool call update can be the first recorded form of a tool call,
        // for example when the announcement itself is an update the history
        // projection cannot merge into an earlier event.
        await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
                kind: "fetch",
                locations: [{ path: "docs/permissions.md", line: 7 }],
                rawInput: { url: "https://example.test/permissions" },
                sessionUpdate: "tool_call_update",
                status: "in_progress",
                title: "Fetch the permissions guide",
                toolCallId: "orphan-update-tool",
            },
        });
        const permission = await context.client.request(acp.methods.client.session.requestPermission, {
            options: [
                { kind: "allow_once", name: "Allow once", optionId: "allow-once" },
                { kind: "reject_once", name: "Reject", optionId: "reject" },
            ],
            sessionId: context.params.sessionId,
            toolCall: { title: "Approve the fetch", toolCallId: "orphan-update-tool" },
        });
        if (permission.outcome.outcome !== "selected") {
            return { stopReason: "cancelled" };
        }
    }
    if (prompt === "ask for many default choices") {
        // The Agent pre-selects every one of its 200 options: far more than a string field's worth of characters.
        const choices = Array.from(
            { length: 200 },
            (_, index) => `branch-${String(index).padStart(3, "0")}-${"x".repeat(45)}`,
        );
        const elicitation = await context.client.request(acp.methods.client.elicitation.create, {
            message: "Choose the branches to verify",
            mode: "form",
            requestedSchema: {
                properties: {
                    branches: {
                        default: choices,
                        items: { enum: choices, type: "string" },
                        title: "Branches",
                        type: "array",
                    },
                },
                type: "object",
            },
            sessionId: context.params.sessionId,
        });
        if (elicitation.action !== "accept") {
            return { stopReason: "cancelled" };
        }
    }
    if (prompt === "exercise URL elicitation") {
        const elicitationId = `url-${turnNumber.toString()}`;
        const elicitation = await context.client.request(acp.methods.client.elicitation.create, {
            elicitationId,
            message: "Connect the test account",
            mode: "url",
            sessionId: context.params.sessionId,
            url: `https://example.com/connect/${elicitationId}`,
        });
        if (elicitation.action !== "accept") {
            return { stopReason: "cancelled" };
        }
        await context.client.notify(acp.methods.client.elicitation.complete, {
            elicitationId,
        });
    }
    return { branch: selectedBranch };
}
