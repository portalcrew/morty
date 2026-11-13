import { createServer, request as httpRequest } from "node:http";
import {
    COMPUTER_SUCCESSOR_CREDENTIAL_HEADER,
    type NativeSessionTarget,
    nativeSessionCommandCodec,
    nativeSessionResultCodec,
} from "@morty-build/client/protocol";
import { listen, port } from "@morty-build/relay-test-support/websocket";
import { type RawData, WebSocket, WebSocketServer } from "ws";

/** Drops a real Computer transport at the Fork boundary; never fabricates a reply. */
export async function createForkLossProxy(upstream: string, loss: "request" | "result") {
    const server = createServer((incoming, outgoing) => {
        const requested = new URL(incoming.url ?? "/", upstream);
        const forwarded = httpRequest(
            new URL(upstream),
            {
                path: requested.pathname + requested.search,
                method: incoming.method,
                headers: { ...incoming.headers, host: new URL(upstream).host },
            },
            (response) => {
                outgoing.writeHead(response.statusCode ?? 502, response.headers);
                response.pipe(outgoing);
            },
        );
        forwarded.on("error", () => outgoing.destroy());
        incoming.pipe(forwarded);
    });
    const peers = new Set<WebSocket>();
    const lost = Promise.withResolvers<NativeSessionTarget | null>();
    let armed = true;
    const sockets = new WebSocketServer({ server });
    sockets.on("connection", (daemon, request) => {
        const requested = new URL(request.url ?? "/", upstream);
        const url = new URL(upstream);
        url.pathname = requested.pathname;
        url.search = requested.search;
        url.protocol = "ws:";
        const relay = new WebSocket(url, {
            headers: Object.fromEntries(
                ["authorization", COMPUTER_SUCCESSOR_CREDENTIAL_HEADER].flatMap((name) => {
                    const value = request.headers[name];
                    return typeof value === "string" ? [[name, value]] : [];
                }),
            ),
        });
        peers.add(daemon);
        peers.add(relay);
        const pending: { readonly data: RawData; readonly binary: boolean }[] = [];
        daemon.on("message", (data, binary) => {
            if (armed && loss === "result" && !binary) {
                const frame: unknown = JSON.parse(data.toString());
                if (
                    typeof frame === "object" &&
                    frame !== null &&
                    "kind" in frame &&
                    frame.kind === "native.session.result"
                ) {
                    const result = nativeSessionResultCodec.decodeRouting(data.toString());
                    if (result.action === "fork") {
                        armed = false;
                        lost.resolve(result.target);
                        daemon.terminate();
                        relay.terminate();
                        return;
                    }
                }
            }
            if (relay.readyState === WebSocket.OPEN) {
                relay.send(data, { binary });
            } else {
                pending.push({ data, binary });
            }
        });
        relay.on("open", () => {
            for (const frame of pending.splice(0)) {
                relay.send(frame.data, { binary: frame.binary });
            }
        });
        relay.on("message", (data, binary) => {
            if (armed && loss === "request" && !binary) {
                const frame: unknown = JSON.parse(data.toString());
                if (
                    typeof frame === "object" &&
                    frame !== null &&
                    "kind" in frame &&
                    frame.kind === "native.session.request"
                ) {
                    const command = nativeSessionCommandCodec.decodeRouting(data.toString());
                    if (command.action === "fork") {
                        armed = false;
                        lost.resolve(null);
                        daemon.terminate();
                        relay.terminate();
                        return;
                    }
                }
            }
            if (daemon.readyState === WebSocket.OPEN) {
                daemon.send(data, { binary });
            }
        });
        for (const [peer, other] of [
            [daemon, relay],
            [relay, daemon],
        ] as const) {
            peer.on("error", () => other.terminate());
            peer.on("close", () => {
                peers.delete(peer);
                other.terminate();
            });
        }
    });
    await listen(server);
    return {
        origin: `http://127.0.0.1:${port(server)}`,
        lost: lost.promise,
        [Symbol.asyncDispose]: async () => {
            for (const peer of peers) {
                peer.terminate();
            }
            sockets.close();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
