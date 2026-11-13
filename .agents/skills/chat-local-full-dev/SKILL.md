---
name: chat-local-full-dev
description: Prepare, debug, and remove an isolated local Morty Worker containing the website and relay. Use when a user asks to run the local Worker, reproduce an API failure locally, watch Worker logs, inspect local Durable Object SQLite, exercise the browser app against local code, or tear the local Worker down. Do not use it to inspect or change a deployed production Worker; use the worker-debug skill for that.
---

# Local Morty development

Run the browser, single Morty Worker and Runtime from this workspace in disposable local
storage. Nothing in this workflow deploys or changes Cloudflare accounts.

1. Confirm the Git root and read its instructions. Use the pinned Node and pnpm.
   Install locked dependencies, run `pnpm db:codegen`, and build the CLI with
   `pnpm build:cli`. No submodule is required.
2. Run `node scripts/local-dev.cjs prepare web-server --background`. Use `web-server-morty-cli`
   to additionally verify the checkout's Runtime. The helper builds browser and CLI
   artifacts and migrates isolated local storage. The stack uses a local signing
   key; setup creates an owner and pairs through the public product boundary.
   Do not print or commit generated credentials.
3. Read the returned JSON for `stateDir`, `chatOrigin` and log
   locations. Do not assume ports. Run one stack per checkout because Wrangler's
   local registry is shared by that checkout.
4. Verify `node scripts/local-dev.cjs status --state-dir <stateDir>`. Drive user
   behavior through the real browser application or its supported API boundary.
   Keep services and Runtime real; only an Agent's ACP dependency may be controlled.
5. For a user-selected Agent and native session, run
   `node scripts/local-dev.cjs setup --state-dir <stateDir> --harness ID --session-id ID`.
   Never substitute a fabricated session ID. The helper isolates Morty under the
   stack directory and uses the checkout's packed CLI. Open the returned handoff in
   the browser; never redeem it from the setup side or record the credential-bearing
   URL in screenshots.
6. Capture representative states under `test-results/` through normal interaction.
   Keep credentials and transfer codes out of screenshots. Read
   `references/debugging.md` before concluding a root cause and correlate the browser
   error with its structured Worker and Runtime logs.
7. Remove only this stack with
   `node scripts/local-dev.cjs remove --state-dir <stateDir>`. Preserve screenshots
   and Agent-owned history. Never use a global process-name kill.

Use `node scripts/local-dev.cjs logs --state-dir <stateDir> --worker all --follow`
for logs. Development uses one local Worker with isolated storage and a local signing key.
It does not require cloud credentials or a separate Relay process.

Run `pnpm lint`, `pnpm typecheck`, and related integration tests. Test installation
through the packed archive. Follow the complete archive acceptance gates in
[TESTING.md](../../../docs/TESTING.md) before publishing a release.
