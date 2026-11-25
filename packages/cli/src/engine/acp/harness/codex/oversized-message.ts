const MAX_SCANNED_TOKEN_LENGTH = 256;

export type OversizedMessage = { readonly kind: "response"; readonly id: number | string } | { readonly kind: "other" };

// A message too large to parse still names the request it answers; reading only its top-level
// `id` and `method` lets the client fail that request while dropping the bytes as they arrive.
export class OversizedMessageScanner {
    #depth = 0;
    #inString = false;
    #escaped = false;
    #expectingKey = false;
    #key = "";
    #valueKey: string | null = null;
    #token: { readonly kind: "key" | "id-string" | "id-number"; text: string } | null = null;
    #id: number | string | null = null;
    #hasMethod = false;

    readonly scan = (text: string): void => {
        for (const character of text) {
            if (this.#inString) {
                this.#scanString(character);
            } else {
                this.#scanStructure(character);
            }
        }
    };

    readonly message = (): OversizedMessage => {
        this.#endNumber();
        return this.#id !== null && !this.#hasMethod ? { kind: "response", id: this.#id } : { kind: "other" };
    };

    readonly #scanString = (character: string): void => {
        if (this.#escaped) {
            this.#escaped = false;
        } else if (character === "\\") {
            this.#escaped = true;
            return;
        } else if (character === '"') {
            this.#inString = false;
            this.#endString();
            return;
        }
        this.#append(character);
    };

    readonly #scanStructure = (character: string): void => {
        switch (character) {
            case '"':
                this.#inString = true;
                if (this.#depth === 1 && this.#expectingKey) {
                    this.#token = { kind: "key", text: "" };
                } else if (this.#depth === 1 && this.#valueKey === "id") {
                    this.#token = { kind: "id-string", text: "" };
                }
                return;
            case "{":
            case "[":
                this.#depth += 1;
                this.#expectingKey = this.#depth === 1 && character === "{";
                return;
            case "}":
            case "]":
                if (this.#depth === 1) {
                    this.#endNumber();
                }
                this.#depth -= 1;
                return;
            case ":":
                if (this.#depth === 1) {
                    this.#expectingKey = false;
                    this.#valueKey = this.#key;
                }
                return;
            case ",":
                if (this.#depth === 1) {
                    this.#endNumber();
                    this.#expectingKey = true;
                    this.#valueKey = null;
                }
                return;
            default:
                if (this.#depth === 1 && this.#valueKey === "id" && /[-+.\deE]/u.test(character)) {
                    this.#token ??= { kind: "id-number", text: "" };
                    this.#append(character);
                }
        }
    };

    readonly #append = (character: string): void => {
        if (this.#token !== null && this.#token.text.length < MAX_SCANNED_TOKEN_LENGTH) {
            this.#token.text += character;
        }
    };

    readonly #endString = (): void => {
        const token = this.#token;
        this.#token = null;
        if (token?.kind === "key") {
            this.#key = token.text;
            this.#hasMethod ||= token.text === "method";
        } else if (token?.kind === "id-string") {
            this.#id = token.text;
        }
    };

    readonly #endNumber = (): void => {
        if (this.#token?.kind !== "id-number") {
            return;
        }
        const id = Number(this.#token.text);
        this.#token = null;
        if (Number.isSafeInteger(id)) {
            this.#id = id;
        }
    };
}
