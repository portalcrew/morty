import type { ConfiguredRelayBindings } from "../../contracts/relay-bindings.ts";
import type { SessionWebSocketServices } from "../components/runtime/websocket/session-websocket-routes.ts";
import type { ComputerServices } from "./computer-services.ts";
import type { RelayContext } from "./relay-services.ts";

export interface ComputerRouteContext {
    readonly bindings: ConfiguredRelayBindings;
    readonly ownsComputer: (computerId: string) => boolean;
    readonly holdsComputer: () => boolean;
    readonly services: {
        readonly browser: ComputerServices;
        readonly relay: (computerId: string) => RelayContext;
        readonly sessions: (computerId: string) => SessionWebSocketServices;
    };
    readonly utilities: {
        readonly connectionOpened: () => Promise<void>;
    };
}
