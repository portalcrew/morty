import { sealedAccessHandoffFormat, sealHandoff } from "@portalcrew/morty-client";
import { base64urlnopad } from "@scure/base";
import { IdentityApiError, type IdentityTransfer, transferCodeComputer } from "./anonymous-identity-api.ts";
import { storedComputerEncryption } from "./remembered-computers.ts";

export type SharedAccess = Omit<IdentityTransfer, "url" | "setupHandoffFormats"> & {
    readonly code: string;
    /** What a person opens: sealed and short enough for a QR code when the Worker's `/continue` page opens that. */
    readonly link: string;
    /** The link the published agent API documents, carrying the code and the encryption access in its fragment. */
    readonly agentLink: string;
};

type StageSealedHandoff = (
    computerId: string,
    handoff: { readonly lookupId: string; readonly sealed: string; readonly accessExpiresAt: string },
    signal: AbortSignal,
) => Promise<void>;

/**
 * The links an issued transfer hands out, each with this browser's Computer encryption access, which never reaches
 * Morty: it stays in a fragment, or sealed under a key only the link holds.
 */
export async function sharedAccess(
    issued: IdentityTransfer,
    stage: StageSealedHandoff,
    signal: AbortSignal,
): Promise<SharedAccess> {
    const { url, setupHandoffFormats, ...terms } = issued;
    const agentLink = new URL(url);
    const fragment = new URLSearchParams(agentLink.hash.slice(1));
    const code = fragment.get("code") ?? "";
    const computerId = transferCodeComputer(code);
    const encryption = computerId === null ? null : storedComputerEncryption(computerId);
    if (computerId === null || encryption === null) {
        throw new IdentityApiError("INVALID_REQUEST", "Encrypted Computer access is required to share this Computer.");
    }
    fragment.set("e2e", base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(encryption))));
    agentLink.hash = fragment.toString();
    if (!setupHandoffFormats.includes(sealedAccessHandoffFormat)) {
        return { ...terms, code, link: agentLink.toString(), agentLink: agentLink.toString() };
    }
    const sealed = await sealHandoff(agentLink.origin, computerId, { kind: "access", handoff: { code, encryption } });
    signal.throwIfAborted();
    await stage(
        computerId,
        { lookupId: sealed.lookupId, sealed: sealed.sealed, accessExpiresAt: terms.accessExpiresAt },
        signal,
    );
    return { ...terms, code, link: sealed.url, agentLink: agentLink.toString() };
}
