import type { Context, Next } from "hono";
import * as v from "valibot";
import { computerIdFromPrefixedValue, decodeComputerPlacement } from "../contracts/computer-id.ts";
import { ComputerManagementError, relayIdentifier } from "../contracts/computer-management.ts";
import { ManagementError } from "../contracts/management-error.ts";
import { readTransferCredential } from "../contracts/transfer-credential.ts";
import { readJsonBody } from "./body-parser.ts";

export type ComputerTargetEnvironment = {
    readonly Variables: { readonly computerId: string };
};

function computerIdentifier(input: unknown): string {
    const parsed = v.safeParse(relayIdentifier, input);
    if (!parsed.success || decodeComputerPlacement(parsed.output) === null) {
        throw new ComputerManagementError("computer_id_invalid", "The Computer identifier is invalid", 400);
    }
    return parsed.output;
}

/** Path claims select a destination only. The owning DO still authorizes every operation. */
export async function computerFromPath<E extends ComputerTargetEnvironment>(context: Context<E>, next: Next) {
    context.set("computerId", computerIdentifier(context.req.param("computerId")));
    await next();
}

export async function computerFromRuntimeCredential<E extends ComputerTargetEnvironment>(
    context: Context<E>,
    next: Next,
) {
    const authorization = context.req.header("authorization") ?? "";
    const computerId = computerIdFromPrefixedValue(authorization.startsWith("Bearer ") ? authorization.slice(7) : "");
    context.set("computerId", computerIdentifier(computerId));
    await next();
}

export async function computerFromTransfer<E extends ComputerTargetEnvironment>(context: Context<E>, next: Next) {
    const input: unknown = await readJsonBody(context.req.raw.clone());
    const parsed = v.safeParse(v.object({ code: v.unknown() }), input);
    const ticket = parsed.success ? readTransferCredential(parsed.output.code) : null;
    if (ticket === null) {
        throw new ManagementError("TRANSFER_UNAVAILABLE", "This link is unavailable.", 410);
    }
    context.set("computerId", computerIdentifier(ticket.computerId));
    await next();
}
