/** Every boundary answers a request for a computer that was never created with this error. */
export const COMPUTER_NOT_FOUND = Object.freeze({
    code: "COMPUTER_NOT_FOUND",
    message: "The Morty computer does not exist.",
    status: 404,
});

/**
 * A browser cannot read the status of a refused WebSocket upgrade, so the browser transport of a computer that was never
 * created is accepted and closed with this frame. 4404 is in RFC 6455's private-use range.
 */
export const COMPUTER_NOT_FOUND_CLOSE = Object.freeze({ code: 4404, reason: COMPUTER_NOT_FOUND.code });
