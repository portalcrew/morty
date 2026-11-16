export const COMPUTER_SUCCESSOR_CREDENTIAL_HEADER = "morty-successor-computer-credential";

const SECRET_LENGTH = 43;
const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43,256}$/u;

function encodeSecret(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * The credential that succeeds `current`: the same routing prefix with a new 256-bit secret. A credential ends with
 * its 43-character secret, so a successor keeps reaching the Computer the current credential belongs to.
 */
export function computerCredentialSuccessor(current: string): string {
    if (!CREDENTIAL_PATTERN.test(current)) {
        throw new TypeError("The Computer credential is invalid");
    }
    return `${current.slice(0, -SECRET_LENGTH)}${encodeSecret(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export function isComputerCredentialSuccessor(current: string, successor: string): boolean {
    return (
        CREDENTIAL_PATTERN.test(current) &&
        CREDENTIAL_PATTERN.test(successor) &&
        successor !== current &&
        successor.length === current.length &&
        successor.slice(0, -SECRET_LENGTH) === current.slice(0, -SECRET_LENGTH)
    );
}
