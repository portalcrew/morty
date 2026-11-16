import { PairingDirectoryError } from "./relay/pairing.ts";

export type ComputerPairing = "unpaired" | "paired" | "revoked";

export function computerRevoked(): PairingDirectoryError {
    return new PairingDirectoryError("computer_revoked", "The Computer has been revoked");
}
