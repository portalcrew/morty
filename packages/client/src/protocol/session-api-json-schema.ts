import { configurationWireJsonSchemas } from "./session/configuration/index.ts";
import { interactionWireJsonSchemas } from "./session/interactions/index.ts";
import { lifecycleWireJsonSchemas } from "./session/lifecycle/index.ts";
import { nativeWireJsonSchemas } from "./session/native/index.ts";
import { historyWireJsonSchemas } from "./session/observability/history.ts";
import { promptWireJsonSchemas } from "./session/prompt/commands.ts";

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
