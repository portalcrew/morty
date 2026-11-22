import * as v from "valibot";

function hasMethods(value: unknown, methods: readonly string[]): boolean {
    return (
        typeof value === "object" &&
        value !== null &&
        methods.every((method) => method in value && typeof Reflect.get(value, method) === "function")
    );
}

export const durableObjectNamespaceBindingSchema = <T extends Rpc.DurableObjectBranded | undefined = undefined>() =>
    v.custom<DurableObjectNamespace<T>>((value) => hasMethods(value, ["get", "idFromName"]));

export interface CloudBindings {
    readonly COMPUTER_RELAY?: unknown;
    readonly ANONYMOUS_CREATION_LIMITER?: unknown;
    readonly APP_ORIGIN?: unknown;
    readonly ASSETS?: unknown;
    readonly MORTY_SESSION_SIGNING_SECRET?: unknown;
    readonly MORTY_ALLOWED_ORIGINS?: unknown;
    readonly CF_VERSION_METADATA?: unknown;
}
