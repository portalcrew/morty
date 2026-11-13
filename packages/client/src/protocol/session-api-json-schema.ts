import { z } from "zod";
import {
    configurationWireJsonSchemas,
    sessionConfigReadResultSchema,
    sessionConfigUpdatedEventSchema,
} from "./session/configuration/index.ts";
import { sessionEventLogPageSchema } from "./session/events/index.ts";
import { interactionWireJsonSchemas } from "./session/interactions/index.ts";
import { lifecycleWireJsonSchemas } from "./session/lifecycle/index.ts";
import { activeTurnResultSchema, nativeWireJsonSchemas } from "./session/native/index.ts";
import { historyWireJsonSchemas } from "./session/observability/history.ts";
import { promptWireJsonSchemas } from "./session/prompt/commands.ts";
import { turnSchema } from "./session/turn/index.ts";

/** Routing envelopes accepted and returned at the Worker boundary. */
export function sessionWireJsonSchemas() {
    return {
        ...lifecycleWireJsonSchemas(),
        ...promptWireJsonSchemas(),
        ...configurationWireJsonSchemas(),
        ...interactionWireJsonSchemas(),
        ...historyWireJsonSchemas(),
        ...nativeWireJsonSchemas(),
    };
}

/**
 * JSON Schemas of the Session results a client reads, generated from the protocol schemas that decode them, so the
 * published API description cannot drift from what the protocol accepts.
 */
export function sessionResultJsonSchemas(): Readonly<
    Record<"activeTurn" | "configuration" | "configurationUpdated" | "eventPage" | "turn", object>
> {
    // Repeated subschemas become `$defs` entries, which keeps the large Session event union readable.
    const options = { target: "draft-2020-12", io: "output", unrepresentable: "any", reused: "ref" } as const;
    return {
        activeTurn: z.toJSONSchema(activeTurnResultSchema, options),
        configuration: z.toJSONSchema(sessionConfigReadResultSchema, options),
        configurationUpdated: z.toJSONSchema(sessionConfigUpdatedEventSchema, options),
        eventPage: z.toJSONSchema(sessionEventLogPageSchema, options),
        turn: z.toJSONSchema(turnSchema, options),
    };
}
