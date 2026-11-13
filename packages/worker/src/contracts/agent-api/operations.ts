import type { sessionWireJsonSchemas } from "@morty-build/client/protocol";
import type * as v from "valibot";
import { transferRedemptionInput } from "./identity-requests.ts";
import { identityResponse, workspaceResponse } from "./responses.ts";

type WireSchema = keyof ReturnType<typeof sessionWireJsonSchemas>;
type ProtocolRequest = Extract<WireSchema, `${string}Request`>;
type ProtocolResult = Extract<WireSchema, `${string}Reply`>;

/** A response body: the schema the route checks it against, a Session result of the protocol, or a fixed shape. */
export type AgentApiResponse =
    | { readonly kind: "schema"; readonly schema: v.GenericSchema }
    | { readonly kind: "protocol"; readonly result: ProtocolResult }
    | { readonly kind: "openSession" }
    | { readonly kind: "credential" }
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
    readonly request?:
        | { readonly kind: "schema"; readonly schema: v.GenericSchema }
        | { readonly kind: "protocol"; readonly schema: ProtocolRequest };
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
        request: { kind: "schema", schema: transferRedemptionInput },
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
        summary: "Request the encrypted list of Sessions in Morty Recent.",
        request: { kind: "protocol", schema: "listRequest" },
        response: { kind: "protocol", result: "listedReply" },
    },
    {
        operationId: "openSession",
        method: "post",
        path: `${chat}/managed-sessions/open`,
        transport: "http",
        security: "computerToken",
        tag: "Chat",
        summary:
            "Open a Session using an encrypted creation command and receive a Session credential and encrypted readiness reply.",
        request: { kind: "protocol", schema: "createRequest" },
        response: { kind: "openSession" },
    },
    {
        operationId: "renewSessionCredential",
        method: "post",
        path: `${chat}/native-sessions/access`,
        transport: "http",
        security: "computerToken",
        tag: "Chat",
        summary: "Issue a fresh Session credential for a Session in Morty Recent; renew before `expiresAt`.",
        request: { kind: "protocol", schema: "prepareRequest" },
        response: { kind: "credential" },
    },
    {
        operationId: "continueNativeSession",
        method: "post",
        path: `${chat}/native-sessions/continue`,
        transport: "http",
        security: "computerToken",
        tag: "Chat",
        summary: "Find or import a native Session using an encrypted command.",
        request: { kind: "protocol", schema: "continuationRequest" },
        response: { kind: "protocol", result: "continuationReply" },
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
        request: { kind: "protocol", schema: "activeTurnRequest" },
        response: { kind: "protocol", result: "activeTurnReply" },
    },
    {
        operationId: "submitTurn",
        method: "post",
        path: `${session}/turns`,
        transport: "websocket",
        security: "sessionCredential",
        tag: "Session",
        summary: "Submit an encrypted prompt. The encrypted reply means accepted, not finished.",
        request: { kind: "protocol", schema: "promptRequest" },
        response: { kind: "protocol", result: "promptReply" },
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
        request: { kind: "protocol", schema: "cancelRequest" },
        response: { kind: "protocol", result: "cancelReply" },
    },
    {
        operationId: "listSessionEvents",
        method: "get",
        path: `${session}/events`,
        transport: "websocket",
        security: "sessionCredential",
        tag: "Session",
        summary: "Request an encrypted page of Session history.",
        request: { kind: "protocol", schema: "historyRequest" },
        response: { kind: "protocol", result: "historyReply" },
    },
    {
        operationId: "readSessionConfiguration",
        method: "get",
        path: `${session}/configuration`,
        transport: "websocket",
        security: "sessionCredential",
        tag: "Session",
        summary: "The Session's options, such as its model.",
        request: { kind: "protocol", schema: "configurationRequest" },
        response: { kind: "protocol", result: "configurationReply" },
    },
    {
        operationId: "updateSessionConfiguration",
        method: "post",
        path: `${session}/configuration`,
        transport: "websocket",
        security: "sessionCredential",
        tag: "Session",
        summary: "Change one Session option, based on the `configurationRevision` last read.",
        request: { kind: "protocol", schema: "configureRequest" },
        response: { kind: "protocol", result: "configuredReply" },
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
        request: { kind: "protocol", schema: "interactionRequest" },
        response: { kind: "protocol", result: "interactionReply" },
    },
];
