import { OperationError } from "../../infra/operation-error.ts";

export class SessionError extends OperationError {
    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(code, message, options);
        this.name = "SessionError";
    }
}
