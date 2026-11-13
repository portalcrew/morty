import { z } from "zod";
import { identifierStringSchema } from "../shared/identifier.ts";
import { decodeZodMessage, encodeZodMessage } from "../shared/message-codec.ts";

/** A Worker grants one chunk to an active file read on its owning connection. */
export const WORKER_FILE_CREDIT_KIND = "worker.file.credit";
const workerFileCreditSchema = z
    .strictObject({
        kind: z.literal(WORKER_FILE_CREDIT_KIND),
        requestId: identifierStringSchema,
        chunks: z.literal(1),
    })
    .readonly();

export type WorkerFileCredit = z.infer<typeof workerFileCreditSchema>;
export const decodeWorkerFileCredit = (encoded: string): WorkerFileCredit =>
    decodeZodMessage(encoded, workerFileCreditSchema);
export const encodeWorkerFileCredit = (message: WorkerFileCredit): string =>
    encodeZodMessage(message, workerFileCreditSchema);
