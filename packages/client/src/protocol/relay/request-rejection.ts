import { z } from "zod";
import { identifierStringSchema } from "../shared/identifier.ts";
import { decodeZodMessage, encodeZodMessage } from "../shared/message-codec.ts";

/** A Worker refusal is a transport control, not a Computer-authored operation result. */
export const WORKER_REQUEST_REJECTED_KIND = "worker.request.rejected";
const workerRequestRejectedSchema = z
    .strictObject({
        kind: z.literal(WORKER_REQUEST_REJECTED_KIND),
        requestId: identifierStringSchema,
        code: identifierStringSchema,
        message: z.string().min(1).max(500),
    })
    .readonly();

export type WorkerRequestRejected = z.infer<typeof workerRequestRejectedSchema>;
export const decodeWorkerRequestRejected = (encoded: string): WorkerRequestRejected =>
    decodeZodMessage(encoded, workerRequestRejectedSchema);
export const encodeWorkerRequestRejected = (message: WorkerRequestRejected): string =>
    encodeZodMessage(message, workerRequestRejectedSchema);

export const workerRequestRejectedCodec = Object.freeze({
    kind: WORKER_REQUEST_REJECTED_KIND,
    decode: decodeWorkerRequestRejected,
    encode: encodeWorkerRequestRejected,
});
