import { z } from "zod";

export const DAEMON_CONTROL_PROTOCOL_VERSION = 3;

const lifecycleRequest = z
    .discriminatedUnion("kind", [
        z.object({ kind: z.literal("status") }),
        z.object({ kind: z.literal("stop") }),
        z.object({ kind: z.literal("reload") }),
        z.object({ kind: z.literal("release") }),
    ])
    .readonly();
export type LifecycleRequest = z.infer<typeof lifecycleRequest>;

export function decodeLifecycleRequest(value: unknown): LifecycleRequest | null {
    const request = lifecycleRequest.safeParse(value);
    return request.success ? request.data : null;
}

const lifecycleResponse = z
    .discriminatedUnion("kind", [
        z.strictObject({
            kind: z.literal("status"),
            protocolVersion: z.literal(DAEMON_CONTROL_PROTOCOL_VERSION),
            daemon: z.strictObject({ pid: z.number().int().positive(), version: z.string() }).readonly(),
        }),
        z.strictObject({ kind: z.literal("stopped") }),
        z.strictObject({ kind: z.literal("reloaded") }),
        z.strictObject({ kind: z.literal("released") }),
        z.strictObject({ kind: z.literal("error"), code: z.string(), message: z.string() }),
    ])
    .readonly();
export type LifecycleResponse = z.infer<typeof lifecycleResponse>;

export function decodeLifecycleResponse(value: unknown): LifecycleResponse {
    return lifecycleResponse.parse(value);
}
