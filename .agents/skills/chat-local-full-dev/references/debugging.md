---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Debugging the local stack

Work from evidence to root cause. The local stack is a real Worker with real
Durable Objects, so most deployed failure modes reproduce locally.

## Where the evidence is

| Evidence | Location |
| --- | --- |
| Morty Worker output | `chatLog` from `prepare` |
| Runtime manager diagnostics | `setupLog` from the stack `runtimes` record (`logs --worker runtime`); read the daemon log with the checkout CLI as shown below |
| Durable Objects | `chatPersist` |
| Stack record (pids, origins, paths) | `<stateDir>/stack.json` |

Read Worker and setup logs with
`node scripts/local-dev.cjs logs --state-dir <stateDir> ...`. Read the paired
daemon's diagnostics through the built checkout CLI:

```sh
node packages/cli/dist/cli.js logs --state-directory <stateDir>/morty
```

Use the selected stack's state directory; do not read another daemon's log.

## Correlating one request

1. Capture the failing browser operation, request method, path, status and time.
   Keep credentials and request bodies containing private content out of reports.
2. Inspect the matching Worker and Runtime logs for that time window. Follow the
   computer and request identifiers when present; do not assume an event name from
   an older release still exists.
3. Read the structured error code and sanitized cause chain. Correlate the cloud
   failure with the local daemon evidence before assigning a root cause.

Branch on typed error codes, never human-readable message text. A successful HTTP
response alone does not establish that the requested Agent operation completed.

## Inspecting persisted state

Durable Object SQLite lives under `<chatPersist>/v3/do/<class-name>/<id>.sqlite`.
Inspect it with the `sqlite3` CLI:

```sh
sqlite3 <path.sqlite> '.tables'
```

The current conversation directory is owned by the connected Runtime.

Durable Object files are WAL-backed. Inspect them through SQLite so the WAL
is included. To stop the stack before inspection while retaining its evidence,
use `node scripts/local-dev.cjs remove --state-dir <stateDir> --keep-state`;
`remove` without `--keep-state` deletes the isolated state directory.

## Common failure modes

| Symptom | Likely cause | Check |
| --- | --- | --- |
| Agent Runtime reconnect loop, close code 1008 `Invalid protocol message` | The running Runtime and local relay use different release contracts | Rebuild the checkout CLI and start a fresh isolated stack through `node scripts/local-dev.cjs prepare web-server --background`; check `morty status` |
| Relay exits after `Can't call WebSocket send() after close()` | A replaced or closing daemon socket received a send | Correlate `chatLog` and Runtime diagnostics; fix the relay boundary |
| Validation failure (400) | The request does not match the current schema | Read the typed error and validation issue path |
| A missing Session or conversation | Wrong computer or local state directory | Compare the requested identity with the stack record |
| A stopped stack's port remains bound | Another stack still owns the port | Use `status` and remove only the identified stack |
| Unresolved workspace packages or duplicated ACP SDK instances | Locked dependencies were not installed consistently | Run `pnpm install --frozen-lockfile` at the workspace root and rebuild the CLI |

## Boundary checklist

When a request fails validation, compare every boundary in order, as the
`worker-debug` skill's "Diagnose across boundaries" lists them.

## Reproduce with a narrow API call

For a contract-level reproduction, call the supported Chat HTTP boundary at
`chatOrigin`. Establish an isolated identity through the setup helper first;
creation is idempotent and requires a creation key. Reuse the fixture's authorized
identity for the relevant computer, and keep credentials out of transcripts and
logs. Do not bypass admission or authorization just to reach a handler.

## Escalating to deployed environments

If the failure only appears in a deployed environment, stop and use the
`worker-debug` skill. Never point a local stack at a Cloudflare account, and never
run `wrangler tail` or `wrangler deploy` from this skill.
