import { release } from "node:os";
import type { CatalogAgent } from "../../agent/catalog.ts";
import type { RuntimeConfig } from "../config.ts";

function version(value: string): string {
    return (
        /(?:^|[\s(v])(\d{1,6}\.\d{1,6}\.\d{1,6}(?:-(?:alpha|beta|rc|dev|preview)(?:[.\d-]{0,24}))?(?:\+[a-f0-9]{1,16})?)(?=$|[\s)])/u.exec(
            value.slice(0, 128),
        )?.[1] ?? "unavailable"
    );
}

/** Classify the resolved executable, without revealing the path, username, or environment values. */
function executableLocation(agent: CatalogAgent): string {
    const path = agent.agentIdentity.realPath.replaceAll("\\", "/");
    if (/\/(?:ChatGPT|Codex)\.app\//u.test(path)) {
        return "desktop_bundle";
    }
    if (path.includes("/node_modules/")) {
        return "node_package";
    }
    if (path.includes("/Cellar/") || path.includes("/homebrew/")) {
        return "homebrew";
    }
    if (path.startsWith("/usr/bin/") || path.startsWith("/bin/")) {
        return "system";
    }
    return "other";
}

function overrideVariable(harness: string): string | null {
    switch (harness) {
        case "codex":
            return "MORTY_CODEX_PATH";
        case "claude":
            return "MORTY_CLAUDE_PATH";
        case "pi":
            return "MORTY_PI_PATH";
        default:
            return null;
    }
}

/** A fresh snapshot of the definitions the Computer actually holds, including after discovery logs rotate. */
export function runtimeEnvironmentDiagnostics(config: RuntimeConfig): readonly Readonly<Record<string, string>>[] {
    const agents = config.catalog.read();
    const timestamp = new Date().toISOString();
    return [
        {
            event: "runtime_environment",
            timestamp,
            platform: process.platform,
            architecture: process.arch,
            osRelease: /^(\d+(?:\.\d+){1,3})/u.exec(release())?.[1] ?? "unavailable",
            nodeVersion: process.versions.node,
            uptimeSeconds: Math.floor(process.uptime()).toString(),
            agentCount: agents.length.toString(),
            omittedAgents: Math.max(0, agents.length - 16).toString(),
        },
        ...agents.slice(0, 16).map((agent) => {
            const override = overrideVariable(agent.harness);
            return {
                event: "agent_inventory",
                timestamp,
                harness: override === null ? "custom" : agent.harness,
                agentVersion: version(agent.agentVersion),
                versionSource: "runtime_catalog",
                executableLocation: executableLocation(agent),
                executableOverride:
                    override === null ? "unknown" : agent.environment[override] === undefined ? "unset" : "set",
                codexHome:
                    agent.harness !== "codex"
                        ? "not_applicable"
                        : agent.environment["CODEX_HOME"] === undefined
                          ? "default"
                          : "custom",
            };
        }),
    ];
}
