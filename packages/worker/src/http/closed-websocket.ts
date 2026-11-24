/** Accepts a WebSocket upgrade only to close it with `frame`, which a peer can read where it cannot read a refusal. */
export function closedWebSocketResponse(frame: { readonly code: number; readonly reason: string }): Response {
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].close(frame.code, frame.reason);
    return new Response(null, { status: 101, webSocket: pair[0] });
}
