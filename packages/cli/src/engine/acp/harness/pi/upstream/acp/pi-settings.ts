import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { environmentHome } from "./environment.js";

function isObject(x: unknown): x is Record<string, unknown> {
    return Boolean(x) && typeof x === "object" && !Array.isArray(x);
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
    // Configuration keys are data: never consult or invoke Object.prototype setters.
    const out: Record<string, unknown> = Object.assign(Object.create(null), a);
    for (const [k, v] of Object.entries(b)) {
        const av = out[k];
        if (isObject(av) && isObject(v)) {
            out[k] = deepMerge(av, v);
        } else {
            out[k] = v;
        }
    }
    return out;
}

function readJsonFile(path: string): Record<string, unknown> {
    try {
        if (!existsSync(path)) {
            return {};
        }
        const raw = readFileSync(path, "utf-8");
        const data = JSON.parse(raw);
        return isObject(data) ? data : {};
    } catch {
        return {};
    }
}

function getMergedSettings(cwd: string, environment: Readonly<NodeJS.ProcessEnv>): Record<string, unknown> {
    const globalSettingsPath = join(getAgentDir(environment), "settings.json");
    const projectSettingsPath = resolve(cwd, ".pi", "settings.json");

    const global = readJsonFile(globalSettingsPath);
    const project = readJsonFile(projectSettingsPath);
    return deepMerge(global, project);
}

export function getAgentDir(environment: Readonly<NodeJS.ProcessEnv> = process.env): string {
    const configured = environment["PI_CODING_AGENT_DIR"];
    return configured ? resolve(configured) : join(environmentHome(environment), ".pi", "agent");
}

/**
 * Mirror pi settings semantics (global + project merge, project overrides global).
 * Only returns the bits we currently need.
 */
export function getEnableSkillCommands(cwd: string, environment: Readonly<NodeJS.ProcessEnv> = process.env): boolean {
    const merged = getMergedSettings(cwd, environment);

    const direct = merged.enableSkillCommands;
    if (typeof direct === "boolean") {
        return direct;
    }

    // Back-compat: some versions used skills.enableSkillCommands
    const nested = isObject(merged.skills) ? merged.skills.enableSkillCommands : undefined;
    if (typeof nested === "boolean") {
        return nested;
    }

    return true;
}

/**
 * Mirror pi's quietStartup setting: if true, pi suppresses the verbose startup prelude.
 * We use it to decide whether to synthesize + emit our own "startup info" message.
 */
export function getQuietStartup(cwd: string, environment: Readonly<NodeJS.ProcessEnv> = process.env): boolean {
    const merged = getMergedSettings(cwd, environment);

    const direct = merged.quietStartup;
    if (typeof direct === "boolean") {
        return direct;
    }

    // Back-compat: some versions used quietStart
    const legacy = (merged as any).quietStart;
    if (typeof legacy === "boolean") {
        return legacy;
    }

    return false;
}
