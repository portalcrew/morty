import { ComputerManagementError } from "../computer-management.ts";

export class RelayAuthenticationConfiguration {
    readonly allowedOrigins: ReadonlySet<string>;
    constructor(allowedOrigins: ReadonlySet<string> = new Set()) {
        if ([...allowedOrigins].some((origin) => origin !== "*" && !validOrigin(origin))) {
            throw new ComputerManagementError("relay_configuration_invalid", "A Relay browser origin is invalid", 500);
        }
        this.allowedOrigins = new Set(allowedOrigins);
    }
}

function validOrigin(value: string): boolean {
    if (value.length === 0 || value.length > 2_048 || value === "*") {
        return false;
    }
    try {
        const parsed = new URL(value);
        return (
            (parsed.protocol === "https:" || parsed.protocol === "http:") &&
            parsed.origin === value &&
            parsed.username.length === 0 &&
            parsed.password.length === 0 &&
            parsed.pathname === "/" &&
            parsed.search.length === 0 &&
            parsed.hash.length === 0
        );
    } catch {
        return false;
    }
}
