import {
    decodeSessionCapabilities,
    isIdentifier,
    MAX_LOCAL_AGENT_DIRECTORY_ENTRIES,
    type SessionCapabilities,
} from "@morty-build/client/protocol";
import type { HttpError } from "../http-error.ts";

export const PAIRING_LIFETIME_MILLISECONDS = 10 * 60 * 1_000;

const PAIRING_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){4}$/;
const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;
export interface AgentDescriptor {
    readonly agentPath: string;
    readonly agentVersion: string;
    readonly capabilities: SessionCapabilities;
    readonly harness: string;
    readonly label: string;
}

export class CreatedComputerPairing {
    readonly expiresAt: string;
    readonly pairingCode: string;
    readonly computerId: string;

    constructor(expiresAt: string, pairingCode: string, computerId: string) {
        this.computerId = computerId;
        this.expiresAt = expiresAt;
        this.pairingCode = pairingCode;
    }
}

export interface ClaimedPairing {
    readonly computerId: string;
    readonly daemonToken: string;
}

export interface VerifiedComputerAccess {
    readonly computerId: string;
}

export class ComputerDescriptor {
    readonly agents: readonly AgentDescriptor[];
    readonly computerName: string;
    readonly computerId: string;
    readonly workspaceName: string;

    constructor(agents: readonly AgentDescriptor[], computerName: string, workspaceName: string, computerId: string) {
        this.agents = agents;
        this.computerId = computerId;
        this.computerName = computerName;
        this.workspaceName = workspaceName;
    }
}

export type PairingStatus =
    | { readonly status: "pending"; readonly expiresAt: string }
    | { readonly status: "expired" }
    | {
          readonly status: "paired";
          readonly agents: readonly AgentDescriptor[];
          readonly computerName: string;
          readonly computerId: string;
          readonly workspaceName: string;
      }
    | { readonly status: "revoked"; readonly revokedAt: string };

export class PairingDirectoryError extends Error implements HttpError {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "PairingDirectoryError";
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: pairingDirectoryErrorStatus(this.code),
    });
}

function pairingDirectoryErrorStatus(code: string): number {
    switch (code) {
        case "pairing_not_found":
            return 404;
        case "unauthorized":
        case "computer_revoked":
            return 401;
        case "computer_access_denied":
            return 403;
        case "pairing_timeout":
        case "directory_timeout":
            return 504;
        case "computer_quota_exceeded":
            return 429;
        case "directory_unavailable":
            return 503;
        default:
            return 400;
    }
}

export function normalizePairingCode(code: string): string {
    const normalized = code.trim().toUpperCase();
    if (!PAIRING_CODE_PATTERN.test(normalized)) {
        throw new PairingDirectoryError("invalid_pairing_code", "The pairing code is invalid or expired");
    }
    return normalized;
}

export async function hashSecret(secret: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Morty's authorized fresh-enrollment cutover leaves old records readable but old bearer hashes unusable. */
export async function hashPairingCredential(secret: string): Promise<string> {
    return await hashSecret(`morty-pairing-v2\0${secret}`);
}

export function parseAgents(encoded: string): readonly AgentDescriptor[] {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (error) {
        throw new PairingDirectoryError("invalid_directory_record", "The paired agent directory is invalid", {
            cause: error,
        });
    }
    return validateAgents(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateAgentCapabilities(value: unknown): SessionCapabilities {
    try {
        return decodeSessionCapabilities(value);
    } catch (cause) {
        throw new PairingDirectoryError("invalid_agents", "The Agent capability catalog is invalid", { cause });
    }
}

export function validateAgents(value: unknown): readonly AgentDescriptor[] {
    if (!Array.isArray(value) || value.length > MAX_LOCAL_AGENT_DIRECTORY_ENTRIES) {
        throw new PairingDirectoryError("invalid_agents", "The ready Agent directory is invalid");
    }

    const agents: AgentDescriptor[] = [];
    const identifiers = new Set<string>();
    for (const candidate of value) {
        if (
            !isRecord(candidate) ||
            !Object.hasOwn(candidate, "agentPath") ||
            !Object.hasOwn(candidate, "agentVersion") ||
            !Object.hasOwn(candidate, "capabilities") ||
            !Object.hasOwn(candidate, "harness") ||
            !Object.hasOwn(candidate, "label")
        ) {
            throw new PairingDirectoryError("invalid_agents", "The local agent directory is invalid");
        }
        const capabilities = validateAgentCapabilities(candidate["capabilities"]);
        const harness = candidate["harness"];
        const label = candidate["label"];
        const agentPath = candidate["agentPath"];
        const agentVersion = candidate["agentVersion"];
        if (
            typeof agentPath !== "string" ||
            agentPath.trim().length === 0 ||
            agentPath.length > 4_096 ||
            typeof agentVersion !== "string" ||
            agentVersion.trim().length === 0 ||
            agentVersion.length > 128 ||
            typeof harness !== "string" ||
            !isIdentifier(harness) ||
            typeof label !== "string" ||
            label.trim().length === 0 ||
            label.length > 80 ||
            identifiers.has(harness)
        ) {
            throw new PairingDirectoryError("invalid_agents", "The local agent directory is invalid");
        }
        identifiers.add(harness);
        agents.push({
            agentPath,
            agentVersion: agentVersion.trim(),
            capabilities,
            harness,
            label: label.trim(),
        });
    }
    return agents;
}

export function validateDisplayName(value: unknown, field: string): string {
    if (typeof value !== "string") {
        throw new PairingDirectoryError(`invalid_${field}`, `The ${field.replaceAll("_", " ")} is invalid`);
    }
    const normalized = value.trim();
    if (normalized.length === 0 || normalized.length > 120) {
        throw new PairingDirectoryError(`invalid_${field}`, `The ${field.replaceAll("_", " ")} is invalid`);
    }
    return normalized;
}

export function validatePairingCode(value: unknown): string {
    if (typeof value !== "string") {
        throw new PairingDirectoryError("invalid_pairing_code", "The pairing code is invalid or expired");
    }
    return normalizePairingCode(value);
}

export function validateIdentifier(value: string, field: string): string {
    if (!isIdentifier(value)) {
        throw new PairingDirectoryError(`invalid_${field}`, `The ${field.replaceAll("_", " ")} is invalid`);
    }
    return value;
}

export function validateToken(value: string): string {
    if (!TOKEN_PATTERN.test(value)) {
        throw new PairingDirectoryError("unauthorized", "A valid computer token is required");
    }
    return value;
}
