import { expect, expectTypeOf, it } from "vitest";
import {
    type ClientToRelayMessage,
    daemonEventSignatures,
    daemonInboundSignatures,
    decodeClientToRelayMessage,
    decodeRelayToDaemonMessage,
    decodeWorkerRequestCancel,
    encodeWorkerRequestCancel,
    type WorkerRequestCancel,
    type WorkerToDaemonMessage,
} from "../../src/protocol/index.ts";

it("Given a daemon message registry, when an endpoint selects a business codec, then no plaintext serializer is available", () => {
    for (const codec of [daemonInboundSignatures["session.prompt"], daemonEventSignatures["session.event.v2"]]) {
        expect(codec).not.toHaveProperty("encoder");
        expect(codec).not.toHaveProperty("decoder");
        expect(codec).not.toHaveProperty("schema");
        expect(codec).not.toHaveProperty("encodeUnknown");
        expect(codec).toHaveProperty("encode");
        expect(codec).toHaveProperty("decode");
        expect(codec).toHaveProperty("decodeRouting");
    }
});

it("Given a Worker-owned native request cancellation, when it crosses the relay-to-daemon boundary, then the Computer receives its exact request address", () => {
    expectTypeOf<Extract<ClientToRelayMessage, { kind: "worker.request.cancel" }>>().toBeNever();
    expectTypeOf<
        Extract<WorkerToDaemonMessage, { kind: "worker.request.cancel" }>
    >().toEqualTypeOf<WorkerRequestCancel>();
    const control: WorkerRequestCancel = { kind: "worker.request.cancel", requestId: "request-1" };
    const encoded = encodeWorkerRequestCancel(control);
    expect(decodeWorkerRequestCancel(encoded)).toEqual(control);
    expect(decodeRelayToDaemonMessage(encoded)).toEqual(control);
    expect(() => decodeClientToRelayMessage(encoded)).toThrowError();
    expect(() => decodeClientToRelayMessage(JSON.stringify({ ...control, encrypted: "opaque" }))).toThrowError();
});

it("Given a malformed Worker cancellation, when it reaches the Computer, then it is rejected rather than changing another request", () => {
    expect(() =>
        decodeRelayToDaemonMessage(JSON.stringify({ kind: "worker.request.cancel", requestId: "" })),
    ).toThrowError();
    expect(() =>
        decodeRelayToDaemonMessage(
            JSON.stringify({
                kind: "worker.request.cancel",
                requestId: "request-1",
                target: { harness: "codex", sessionId: "s-1" },
            }),
        ),
    ).toThrowError();
});
