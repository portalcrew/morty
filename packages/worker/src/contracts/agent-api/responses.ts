import { IDENTIFIER_PATTERN } from "@morty-build/client/protocol";
import * as v from "valibot";

// The response bodies of the Identity and Chat operations an AI agent uses. The routes pass each body through
// `documented`, so the compiler rejects a body that no longer matches the schema the agent API description is
// generated from. Fields a response carries beyond its schema are not part of the published contract.

const timestamp = v.pipe(v.string(), v.isoTimestamp());
const identifier = v.pipe(v.string(), v.regex(IDENTIFIER_PATTERN));
const sessionTarget = v.object({ harness: identifier, sessionId: identifier });

/** Access that redeeming a continue link grants this device. */
export const identityResponse = v.object({
    computerToken: v.pipe(v.string(), v.description("Secret. Authenticates Chat operations until the access expires.")),
    computerId: v.string(),
});

/** Whether the Computer is online, and the Agent harnesses it offers. */
export const workspaceResponse = v.object({
    computer: v.object({
        computerId: v.string(),
        computerName: v.string(),
        online: v.boolean(),
        agents: v.pipe(v.array(v.object({ harness: v.string(), label: v.string() })), v.readonly()),
    }),
});

const sessionCredential = {
    computerId: v.string(),
    credential: v.pipe(v.string(), v.description("Secret. Authenticates Session operations until `expiresAt`.")),
    expiresAt: timestamp,
    target: sessionTarget,
};

/** A short-lived Session credential for a Session the Computer holds. */
export const sessionAccessResponse = v.object(sessionCredential);

/** An opened Session and its Session credential. */
export const chatAccessResponse = v.object({
    ...sessionCredential,
    harness: v.string(),
    ready: v.pipe(v.unknown(), v.description("The Computer's opaque encrypted Session readiness reply.")),
});

/** Returns a response body after the compiler checked it against the schema the agent API description publishes. */
export function documented<TSchema extends v.GenericSchema>(_schema: TSchema, body: v.InferOutput<TSchema>) {
    return body;
}
