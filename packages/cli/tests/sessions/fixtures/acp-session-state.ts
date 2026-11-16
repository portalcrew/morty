import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export class ControlledSessionState {
    readonly fastMode: boolean;
    readonly mode: string;
    readonly model: string;
    readonly reasoningEffort: string;
    readonly turnCount: number;

    constructor(
        turnCount: number,
        model = "test-small",
        reasoningEffort = process.argv.includes("--effort-provider-default") ? "" : "medium",
        fastMode = false,
        mode = "code",
    ) {
        this.fastMode = fastMode;
        this.mode = mode;
        this.model = model;
        this.reasoningEffort = reasoningEffort;
        this.turnCount = turnCount;
    }

    readonly withTurnCount = (turnCount: number): ControlledSessionState =>
        new ControlledSessionState(turnCount, this.model, this.reasoningEffort, this.fastMode, this.mode);

    readonly withMode = (mode: string): ControlledSessionState =>
        new ControlledSessionState(this.turnCount, this.model, this.reasoningEffort, this.fastMode, mode);

    readonly withConfig = (configId: string, value: unknown): ControlledSessionState => {
        if (configId === "model" && typeof value === "string") {
            return new ControlledSessionState(this.turnCount, value, this.reasoningEffort, this.fastMode, this.mode);
        }
        if (configId === "reasoning_effort" && typeof value === "string") {
            return new ControlledSessionState(this.turnCount, this.model, value, this.fastMode, this.mode);
        }
        if (configId === "fast_mode" && typeof value === "boolean") {
            return new ControlledSessionState(this.turnCount, this.model, this.reasoningEffort, value, this.mode);
        }
        throw new Error("Unknown fake ACP configuration option");
    };
}

export const nativeHistory = new Map<
    string,
    {
        readonly messageId: string;
        readonly role: "user" | "assistant";
        readonly text: string;
        readonly images?: readonly {
            readonly data: string;
            readonly mimeType: string;
        }[];
    }[]
>();

export const nativeMetadata = new Map<
    string,
    {
        readonly cwd: string;
        readonly title: string;
    }
>();

// Observe real subprocess lifetime at the external Agent boundary without inspecting manager internals.
const processDirectory = process.env["MORTY_FAKE_ACP_PROCESS_DIRECTORY"] ?? "";
const processMarkerId = process.env["MORTY_FAKE_ACP_PROCESS_ID"] ?? "";
const processMarkerPath =
    processDirectory.length === 0 || processMarkerId.length === 0
        ? ""
        : join(processDirectory, `${encodeURIComponent(processMarkerId)}.process`);
if (processMarkerPath.length > 0) {
    mkdirSync(processDirectory, { recursive: true });
    writeFileSync(processMarkerPath, String(process.pid), { flag: "wx" });
}
// The real Codex writer cannot be shared safely or deterministically in tests.
// Model its exclusive ownership at the external Agent boundary with real files.
const writerFiles = new Map<string, string>();
export function acquireWriter(sessionId: string): void {
    const directory = process.env["MORTY_FAKE_ACP_STATE_DIRECTORY"];
    if (directory === undefined || !process.argv.includes("--exclusive-writer") || writerFiles.has(sessionId)) {
        return;
    }
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${encodeURIComponent(sessionId)}.writer`);
    writeFileSync(path, String(process.pid), { flag: "wx" });
    writerFiles.set(sessionId, path);
}
export function releaseWriter(sessionId: string): void {
    const path = writerFiles.get(sessionId);
    if (path === undefined) {
        return;
    }
    unlinkSync(path);
    writerFiles.delete(sessionId);
}
process.on("exit", () => {
    for (const id of writerFiles.keys()) {
        releaseWriter(id);
    }
    if (processMarkerPath.length > 0 && existsSync(processMarkerPath)) {
        unlinkSync(processMarkerPath);
    }
});
process.on("SIGTERM", () => process.exit(0));

export function readPersistedState(sessionId: string): ControlledSessionState {
    const directory = process.env["MORTY_FAKE_ACP_STATE_DIRECTORY"];
    if (directory === undefined) {
        throw new Error("Fake ACP persistence is not configured");
    }
    const path = join(directory, `${encodeURIComponent(sessionId)}.json`);
    const decoded: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
        throw new Error("Invalid fake ACP state");
    }
    const history = Reflect.get(decoded, "history");
    if (Array.isArray(history)) {
        nativeHistory.set(
            sessionId,
            history.map((message: unknown, index: number) => {
                if (typeof message !== "object" || message === null) {
                    throw new Error("Invalid saved message");
                }
                const role = Reflect.get(message, "role");
                const text = Reflect.get(message, "text");
                const persistedMessageId = Reflect.get(message, "messageId");
                if ((role !== "user" && role !== "assistant") || typeof text !== "string") {
                    throw new Error("Invalid saved message");
                }
                const images: unknown = Reflect.get(message, "images");
                const messageId =
                    typeof persistedMessageId === "string" ? persistedMessageId : `saved-${index.toString()}`;
                if (images === undefined) {
                    return { messageId, role, text };
                }
                if (!Array.isArray(images)) {
                    throw new Error("Invalid saved images");
                }
                return {
                    role,
                    text,
                    messageId,
                    images: images.map((image: unknown) => {
                        if (typeof image !== "object" || image === null) {
                            throw new Error("Invalid saved image");
                        }
                        const data: unknown = Reflect.get(image, "data");
                        const mimeType: unknown = Reflect.get(image, "mimeType");
                        if (typeof data !== "string" || typeof mimeType !== "string") {
                            throw new Error("Invalid saved image");
                        }
                        return { data, mimeType };
                    }),
                };
            }),
        );
    }
    const turnCount = Reflect.get(decoded, "turnCount");
    const model = Reflect.get(decoded, "model");
    const reasoningEffort = Reflect.get(decoded, "reasoningEffort");
    const fastMode = Reflect.get(decoded, "fastMode");
    const mode = Reflect.get(decoded, "mode");
    const cwd = Reflect.get(decoded, "cwd");
    const title = Reflect.get(decoded, "title");
    if (typeof cwd === "string" && typeof title === "string") {
        nativeMetadata.set(sessionId, {
            cwd,
            title,
        });
    }
    if (
        typeof turnCount !== "number" ||
        typeof model !== "string" ||
        typeof reasoningEffort !== "string" ||
        typeof fastMode !== "boolean" ||
        (mode !== undefined && typeof mode !== "string")
    ) {
        throw new Error("Invalid fake ACP state");
    }
    return new ControlledSessionState(
        turnCount,
        model,
        reasoningEffort,
        fastMode,
        typeof mode === "string" ? mode : "code",
    );
}

export function readRecoveredState(sessionId: string): ControlledSessionState {
    const state = readPersistedState(sessionId);
    return process.argv.includes("--recover-default-settings") ? new ControlledSessionState(state.turnCount) : state;
}

export function persistState(sessionId: string, state: ControlledSessionState): void {
    const directory = process.env["MORTY_FAKE_ACP_STATE_DIRECTORY"];
    if (directory === undefined) {
        return;
    }
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, `${encodeURIComponent(sessionId)}.json`),
        JSON.stringify({
            ...state,
            ...nativeMetadata.get(sessionId),
            history: nativeHistory.get(sessionId) ?? [],
        }),
    );
}

export const sessions = new Map<string, ControlledSessionState>();
export const turnCancellations = new Map<string, AbortController>();
export const steeringWaiters = new Map<string, PromiseWithResolvers<string>>();
