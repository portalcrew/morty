import { type Identifier, isIdentifier } from "@portalcrew/morty-client/protocol";
import * as v from "valibot";
import type { HttpError } from "./http-error.ts";

export const relayIdentifier = v.custom<Identifier>(isIdentifier);

export class ComputerManagementError extends Error implements HttpError {
    readonly code: string;
    readonly status: number;
    constructor(code: string, message: string, status: number, options?: ErrorOptions) {
        super(message, options);
        this.name = "ComputerManagementError";
        this.code = code;
        this.status = status;
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: this.status,
    });
}
