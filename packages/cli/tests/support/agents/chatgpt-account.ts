import { createServer, type ServerResponse } from "node:http";

function base64Url(value: unknown): string {
    return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
}

function respond(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
}

export class FakeChatGptAccount implements AsyncDisposable {
    static readonly accessToken = "morty-chatgpt-fixture";
    static readonly accountId = "morty-chatgpt-account";
    static readonly usageResetsAt = Date.parse("2026-11-21T15:00:00Z") / 1_000;

    readonly origin: string;
    readonly #availableResets: () => number;
    readonly #close: () => Promise<void>;

    private constructor(origin: string, availableResets: () => number, close: () => Promise<void>) {
        this.origin = origin;
        this.#availableResets = availableResets;
        this.#close = close;
    }

    static async start(options: { readonly resets: number }): Promise<FakeChatGptAccount> {
        let availableResets = options.resets;
        const routes: Readonly<Record<string, () => unknown>> = {
            "GET /api/codex/usage": () => ({
                plan_type: "pro",
                rate_limit: {
                    allowed: false,
                    limit_reached: true,
                    primary_window: {
                        used_percent: 100,
                        limit_window_seconds: 18_000,
                        reset_after_seconds: 3_600,
                        reset_at: FakeChatGptAccount.usageResetsAt,
                    },
                },
                rate_limit_reset_credits: { available_count: availableResets },
            }),
            "POST /api/codex/rate-limit-reset-credits/consume": () => {
                if (availableResets === 0) {
                    return { code: "no_credit" };
                }
                availableResets -= 1;
                return { code: "reset", windows_reset: 1 };
            },
        };
        const server = createServer((request, response) => {
            const route = routes[`${request.method ?? ""} ${new URL(request.url ?? "/", "http://localhost").pathname}`];
            if (route === undefined) {
                respond(response, 404, { detail: "Not found" });
            } else if (request.headers.authorization !== `Bearer ${FakeChatGptAccount.accessToken}`) {
                respond(response, 401, { detail: "Unauthorized" });
            } else {
                respond(response, 200, route());
            }
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string") {
            server.close();
            throw new Error("The fake ChatGPT account did not bind a TCP port");
        }
        return new FakeChatGptAccount(
            `http://127.0.0.1:${address.port.toString()}`,
            () => availableResets,
            () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
        );
    }

    // Codex reads the ChatGPT account from the ID token's claims without verifying its signature.
    authFile(): string {
        const idToken = [
            base64Url({ alg: "none", typ: "JWT" }),
            base64Url({
                email: "morty@example.com",
                "https://api.openai.com/auth": {
                    chatgpt_account_id: FakeChatGptAccount.accountId,
                    chatgpt_plan_type: "pro",
                    chatgpt_user_id: "morty-chatgpt-user",
                },
            }),
            base64Url("signature"),
        ].join(".");
        return JSON.stringify({
            auth_mode: "chatgpt",
            OPENAI_API_KEY: null,
            tokens: {
                id_token: idToken,
                access_token: FakeChatGptAccount.accessToken,
                refresh_token: "morty-chatgpt-refresh",
                account_id: FakeChatGptAccount.accountId,
            },
            // Codex only uses tokens with a recorded refresh, and a future one is never due for its scheduled refresh.
            last_refresh: "2100-01-01T00:00:00Z",
        });
    }

    availableResets(): number {
        return this.#availableResets();
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.#close();
    }
}
