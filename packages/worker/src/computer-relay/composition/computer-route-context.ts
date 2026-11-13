import type { ConfiguredRelayBindings } from "../../contracts/relay-bindings.ts";
import type { SessionWebSocketServices } from "../components/runtime/websocket/session-websocket-routes.ts";
import type { ComputerServices } from "./computer-services.ts";
import type { RelayContext } from "./relay-services.ts";

/** The owning DO composes this context once for its HTTP route groups. */
export interface ComputerRouteContext {
    readonly bindings: ConfiguredRelayBindings;
    readonly ownsComputer: (computerId: string) => boolean;
    readonly services: {
        readonly browser: ComputerServices;
        readonly relay: (computerId: string) => RelayContext;
        readonly accounts: { readonly create: (signal: AbortSignal) => Promise<void> };
        readonly sessions: (computerId: string) => SessionWebSocketServices;
    };
    readonly utilities: {
        readonly connectionOpened: () => Promise<void>;
    };
}
