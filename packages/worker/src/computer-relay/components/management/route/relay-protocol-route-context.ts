import type { RelayContext } from "../../../composition/relay-services.ts";

export interface RelayProtocolRouteContext {
    readonly services: { readonly forComputer: (computerId: string) => RelayContext };
}
