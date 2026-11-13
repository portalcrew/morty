/** Business plaintext remains bounded independently of its encrypted transport representation. */
export const ENCRYPTED_MESSAGE_MAX_PLAINTEXT_BYTES = 8 * 1024 * 1024;

/** Includes the authenticated packet, base64 encoding and public routing envelope. */
export const ENCRYPTED_MESSAGE_MAX_WIRE_BYTES = 12 * 1024 * 1024;
