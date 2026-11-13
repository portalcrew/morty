import type * as v from "valibot";
import { accessInput, nativeContinuationInput, nativeSessionTargetInput } from "./chat-requests.ts";
import { transferRedemptionInput } from "./identity-requests.ts";
import {
    chatAccessResponse,
    identityResponse,
    managedSessionsResponse,
    nativeContinuationResponse,
    sessionAccessResponse,
    workspaceResponse,
} from "./responses.ts";
import { interactionResponseRequest, sessionConfigurationRequest, turnSubmissionRequest } from "./session-requests.ts";

/** A Session result the client protocol defines; its JSON Schema comes from that protocol schema. */
type ProtocolResult = "activeTurn" | "configuration" | "configurationUpdated" | "eventPage" | "turn";

/** A response body: the schema the route checks it against, a Session result of the protocol, or a fixed shape. */
export type AgentApiResponse =
    | { readonly kind: "schema"; readonly schema: v.GenericSchema }
    | { readonly kind: "protocol"; readonly result: ProtocolResult }
    | { readonly kind: "json"; readonly schema: object };

interface AgentApiParameter {
    readonly name: string;
    readonly in: "path" | "query";
    readonly description?: string;
    readonly schema: object;
}

/**
 * One operation an AI agent uses. `transport` says how it is reached: `http` operations are routes of the Worker,
 * `websocket` operations are dispatched from `http.request` frames on the Computer transport and answer 404 over HTTP.
 * The websocket entries' paths are the ones the transport's Session dispatcher decodes.
 */
export interface AgentApiOperation {
    readonly operationId: string;
    readonly method: "get" | "post";
    readonly path: string;
    readonly transport: "http" | "websocket";
    readonly security: "none" | "computerToken" | "sessionCredential";
    readonly tag: "Identity" | "Chat" | "Session";
    readonly summary: string;
    readonly parameters?: readonly AgentApiParameter[];
    readonly request?: v.GenericSchema;
    readonly response: AgentApiResponse;
}

const chat = "/morty/api/v1/computers/{computerId}";
const session = "/morty/api/v1/computers/{computerId}/harnesses/{harness}/sessions/{sessionId}";
const identifierParameter = (name: string, location: "path" | "query", description?: string): AgentApiParameter => ({
    name,
    in: location,
    ...(description === undefined ? {} : { description }),
    schema: { $ref: "#/components/schemas/Identifier" },
});

export const agentApiOperations: readonly AgentApiOperation[] = [
    {
        operationId: "redeemTransfer",
        method: "post",
        path: "/morty/api/v1/identity/transfers/redeem",
        transport: "http",
        security: "none",
        tag: "Identity",
        summary:
            "Redeem the one-time `code` from a continue link's URL fragment. Answers 410 TRANSFER_UNAVAILABLE when the link was used, expired, or revoked.",
        request: transferRedemptionInput,
        response: { kind: "schema", schema: identityResponse },
    },
    {
        operationId: "readWorkspace",
        method: "post",
        path: `${chat}/workspace`,
        transport: "http",
        security: "computerToken",
        tag: "Chat",
        summary: "Whether the Computer is online, and which Agent harnesses it offers.",
        response: { kind: "schema", schema: workspaceResponse },
    },
    {
        operationId: "listManagedSessions",
        method: "post",
        path: `${chat}/managed-sessions`,
        transport: "http",
        security: "computerToken",
        tag: "Chat",
        summary: "The Sessions in Morty Recent.",
        response: { kind: "schema", schema: managedSessionsResponse },
    },
    {
        operationId: "openSession",
        method: "post",
        path: `${chat}/managed-sessions/open`,
        transport: "http",
        security: "computerToken",
        tag: "Chat",
        summary:
            "Open a Session in Morty Recent, or start a new conversation in a working directory, and receive a Session credential. Repeating a `conversationKey` reopens the conversation it started.",
        request: accessInput,
        response: { kind: "schema", schema: chatAccessResponse },
    },
    {
        operationId: "renewSessionCredential",
        method: "post",
        path: `${chat}/native-sessions/access`,
        transport: "http",
        security: "computerToken",
        tag: "Chat",
        summary: "Issue a fresh Session credential for a Session in Morty Recent; renew before `expiresAt`.",
        request: nativeSessionTargetInput,
        response: { kind: "schema", schema: sessionAccessResponse },
    },
    {
        operationId: "continueNativeSession",
        method: "post",
        path: `${chat}/native-sessions/continue`,
        transport: "http",
        security: "computerToken",
        tag: "Chat",
        summary: "Import a Session that exists on the Computer but is not in Morty Recent yet.",
        request: nativeContinuationInput,
        response: { kind: "schema", schema: nativeContinuationResponse },
    },
    {
        operationId: "readActiveTurn",
        method: "get",
        path: `${session}/active-turn`,
        transport: "websocket",
        security: "sessionCredential",
        tag: "Session",
        summary: "The running turn, queued prompts, and the outcome of the last turn.",
        parameters: [identifierParameter("commandId", "query", "Also report the delivery of this command.")],
        response: { kind: "protocol", result: "activeTurn" },
    },
    {
        operationId: "submitTurn",
        method: "post",
        path: `${session}/turns`,
        transport: "websocket",
        security: "sessionCredential",
        tag: "Session",
        summary:
            "Submit a prompt. The answer means accepted, not finished. Resend the same body with the same `idempotencyKey` to retry the same turn.",
        request: turnSubmissionRequest,
        response: { kind: "protocol", result: "turn" },
    },
    {
        operationId: "cancelTurn",
        method: "post",
        path: `${session}/turns/{turnId}/cancel`,
        transport: "websocket",
        security: "sessionCredential",
        tag: "Session",
        summary: "Stop a running turn.",
        parameters: [identifierParameter("turnId", "path")],
        response: {
            kind: "json",
            schema: {
                type: "object",
                required: ["turnId"],
                properties: { turnId: { $ref: "#/components/schemas/Identifier" }, stopReason: { type: "string" } },
            },
        },
    },
    {
        operationId: "listSessionEvents",
        method: "get",
        path: `${session}/events`,
        transport: "websocket",
        security: "sessionCredential",
        tag: "Session",
        summary: "The latest page of Session events. Pass a page's `nextCursor` as `cursor` for the preceding page.",
        parameters: [
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 10_000, default: 50 } },
            { name: "cursor", in: "query", schema: { type: "string", minLength: 1, maxLength: 512 } },
        ],
        response: { kind: "protocol", result: "eventPage" },
    },
    {
        operationId: "readSessionConfiguration",
        method: "get",
        path: `${session}/configuration`,
        transport: "websocket",
        security: "sessionCredential",
        tag: "Session",
        summary: "The Session's options, such as its model.",
        response: { kind: "protocol", result: "configuration" },
    },
    {
        operationId: "updateSessionConfiguration",
        method: "post",
        path: `${session}/configuration`,
        transport: "websocket",
        security: "sessionCredential",
        tag: "Session",
        summary: "Change one Session option, based on the `configurationRevision` last read.",
        request: sessionConfigurationRequest,
        response: { kind: "protocol", result: "configurationUpdated" },
    },
    {
        operationId: "respondToInteraction",
        method: "post",
        path: `${session}/interactions/{interactionId}/responses`,
        transport: "websocket",
        security: "sessionCredential",
        tag: "Session",
        summary: "Answer a permission request or question the Agent is waiting on.",
        parameters: [identifierParameter("interactionId", "path")],
        request: interactionResponseRequest,
        response: {
            kind: "json",
            schema: { type: "object", required: ["accepted"], properties: { accepted: { const: true } } },
        },
    },
];
