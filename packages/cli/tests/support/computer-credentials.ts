import { computerCredentialSuccessor } from "@portalcrew/morty-client/protocol";
import type {
    ComputerCredentialRotation,
    ComputerCredentials,
} from "../../src/engine/runtime/connection/computer-credentials.ts";

/** Keeps a Computer credential and its rotations in memory, for an embedding host that outlives no restart. */
export function memoryComputerCredentials(initial: string): ComputerCredentials {
    let current = initial;
    let pending: ComputerCredentialRotation | null = null;
    return {
        prepare: async () => {
            pending ??= { current, successor: computerCredentialSuccessor(current) };
            return pending;
        },
        complete: async (rotation) => {
            if (pending?.successor === rotation.successor) {
                current = rotation.successor;
                pending = null;
            }
        },
        held: async () => ({ current, successor: pending?.successor ?? null }),
    };
}
