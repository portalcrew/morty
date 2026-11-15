import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/cli/migrations/computer-replay-ledger",
    schema: "packages/cli/src/engine/schema/computer-replay-ledger/index.ts",
});
