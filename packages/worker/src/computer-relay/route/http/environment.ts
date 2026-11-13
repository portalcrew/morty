import type { ConfiguredRelayBindings } from "../../../contracts/relay-bindings.ts";
import type { ComputerTargetEnvironment } from "../../../http/computer-target.ts";

export type RelayProtocolEnvironment = ComputerRouteHttpEnvironment;

export type ComputerRouteHttpEnvironment = {
    readonly Bindings: ConfiguredRelayBindings;
    readonly Variables: ComputerTargetEnvironment["Variables"] & { readonly signal: AbortSignal };
};
