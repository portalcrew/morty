import { isDirectoryPath } from "@morty-build/client/protocol";
import * as v from "valibot";
import { relayIdentifier } from "../computer-management.ts";

// The request bodies the Chat API accepts. Its routes validate with these schemas, and the published agent API
// description is generated from them.

/** An absolute directory on the Computer. */
export const nativeDirectory = v.custom<string>(isDirectoryPath);
const sessionConfiguration = v.strictObject({
    booleanValue: v.boolean(),
    configId: relayIdentifier,
    value: v.pipe(v.string(), v.maxLength(500)),
    valueType: v.picklist(["select", "boolean"]),
});
const sessionConfigurations = v.pipe(
    v.array(sessionConfiguration),
    v.maxLength(100),
    v.check(
        (selections) => new Set(selections.map((selection) => selection.configId)).size === selections.length,
        "Session configuration identifiers must be unique.",
    ),
);
/** One Session the Computer holds. */
export const nativeSessionTargetInput = v.strictObject({ harness: relayIdentifier, sessionId: relayIdentifier });
/** Imports a native Session the Computer has but Morty Recent does not list yet. */
export const nativeContinuationInput = v.strictObject({ harness: relayIdentifier, sessionId: relayIdentifier });
/** Opens a Session the Computer holds, or starts a new conversation in a working directory. */
export const accessInput = v.union([
    nativeSessionTargetInput,
    v.strictObject({
        harness: relayIdentifier,
        conversationKey: v.pipe(
            relayIdentifier,
            v.description("Generated once per intended conversation; repeating it reopens that conversation."),
        ),
        configurations: v.pipe(sessionConfigurations, v.description("Send [] for the Agent's defaults.")),
        workspaceRef: v.pipe(
            nativeDirectory,
            v.description("The working directory; reuse the `directory` of a Session in Morty Recent."),
        ),
    }),
]);
