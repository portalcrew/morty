import { z } from "zod";
import { identifierStringSchema } from "../shared/identifier.ts";
import { decodeZodMessage, encodeZodMessage } from "../shared/message-codec.ts";

export const WORKER_REQUEST_CANCEL_KIND = "worker.request.cancel";
const workerRequestCancelSchema = z
    .strictObject({
        kind: z.literal(WORKER_REQUEST_CANCEL_KIND),
        requestId: identifierStringSchema,
    })
    .readonly();

export type WorkerRequestCancel = z.infer<typeof workerRequestCancelSchema>;
export const decodeWorkerRequestCancel = (encoded: string): WorkerRequestCancel =>
    decodeZodMessage(encoded, workerRequestCancelSchema);
export const encodeWorkerRequestCancel = (message: WorkerRequestCancel): string =>
    encodeZodMessage(message, workerRequestCancelSchema);
export const workerRequestCancelCodec = Object.freeze({
    kind: WORKER_REQUEST_CANCEL_KIND,
    decode: decodeWorkerRequestCancel,
    encode: encodeWorkerRequestCancel,
});
