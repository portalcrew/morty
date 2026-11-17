export class DatabaseError extends Error {
    readonly code: "database_unavailable" | "database_statement_invalid";
    constructor(code: DatabaseError["code"], message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.name = "DatabaseError";
        this.code = code;
    }
}
