import { writeFileSync } from "node:fs";

const record = process.env["MORTY_TEST_ENVIRONMENT_RECORD"];
if (record === undefined) {
    throw new Error("The environment recorder needs MORTY_TEST_ENVIRONMENT_RECORD");
}
writeFileSync(record, JSON.stringify({ stateDirectory: process.env["MORTY_STATE_DIRECTORY"] ?? null }));
await import("./acp-peer.ts");
