---
name: cli-debug
description: Debug Morty CLI daemon failures on a user's local machine using the bounded local diagnostic log. Use when a user asks why a local Agent operation failed (for example a native session import, fork, or preview returning "The local agent operation could not be completed."), where the daemon writes diagnostics, how to read logs/daemon.log, or how to correlate a Morty relay failure code with the local cause.
---

# CLI Debugging

Investigate Morty CLI (local daemon) failures from the local diagnostic log to
root cause. The daemon keeps its own evidence on the user's machine; prefer that
file over asking the user to reproduce or enabling verbose output.

## Establish the target

Resolve the CLI state root before anything else: an absolute
`MORTY_STATE_DIRECTORY` in the daemon process's environment wins; otherwise it is
the platform default described in
[Data ownership and recovery](../../../docs/GUIDE.md#data-ownership-and-recovery).

Read the variable from the environment the daemon actually runs in (for example
the shell or service definition that started it); do not assume your current
shell matches.

Collect the selected daemon's diagnostics through the CLI, using its resolved
state root explicitly:

```sh
morty logs --state-directory <state-root>
```

For a managed local stack, use the built checkout CLI with the stack's isolated
Morty directory:

```sh
node packages/cli/dist/cli.js logs --state-directory <stack-state>/morty
```

The local-stack command `logs --worker runtime` reads setup output; it does not
collect the daemon's diagnostic files. Do not substitute another daemon's logs.

The Computer diagnostic log is:

```text
<state-root>/computer/logs/daemon.log
```

Created lazily on the first recorded diagnostic, reused across daemon restarts,
mode `0600` inside a mode `0700` `logs/` directory, and bounded at 1 MiB: when a
new record would exceed the limit, the oldest complete lines are removed first,
so the newest history is always retained.

The CLI also collects manager-written lifecycle and unhandled-rejection logs
from that same private computer directory, including when the daemon is stopped.

Confirm the CLI version the user runs (`morty --version` or the installed
package version). Compare the invoking CLI and running Runtime versions using
`morty status`; an absent diagnostic file can mean no event has been recorded.

## Read the log

Each line is one JSON diagnostic whose prefix is `Morty relay diagnostic` or
`Morty daemon diagnostic`, followed by an object with an `event` name.

Extract evidence with line-oriented tools; the file is small by design:

```sh
MORTY_DIAGNOSTIC_LOG='/absolute/path/to/logs/daemon.log'
tail -n 200 "$MORTY_DIAGNOSTIC_LOG"
rg '"event":"native_session_operation_failed"' "$MORTY_DIAGNOSTIC_LOG" | tail -n 5
```

For failure events, read the cause chain fields `failureName`,
`failureMessage`, `failureCode`, then `cause1*`, `cause2*` for the underlying
error. The message is sanitized before it is written: control characters are
replaced, credential-looking query parameters are redacted, URLs are reduced to
their origin, and the line is truncated. Treat redaction markers (`[redacted]`,
`[redacted-url]`, `[local-path]`) as evidence of sanitization, not corruption.

Note what is intentionally not in the log: full stdout/stderr of child Agents,
prompt content, and session transcripts. Do not try to recover those from this
file. Conversation history belongs to the Agent; inspect its native history only
when the user has authorized that investigation.

## Correlate a remote failure

When the user reports a failure seen in Chat or the Morty relay (for example
code `session_operation_failed` or the generic "The local agent operation could
not be completed." message), the UI message is collapsed at the daemon boundary
on purpose; the concrete cause is only in the local log.

Correlate by:

1. Time window: convert the user-visible failure time to the same clock and
   inspect that range of lines.
2. `computerId`: match the paired computer shown in the browser.
3. `requestId` or `sessionId`: match when the reporter can supply one.
4. `harness` and `action` (`list`/`find`/`preview`/`import`/`fork`) on
   `native_session_operation_failed` events.

Keep the daemon's error taxonomy straight when interpreting codes:
`native_session_busy` is the daemon's own per-agent native-operation guard (a
concurrent operation was still running), not an Agent or Codex lock; Agent-side
rejections surface as typed Agent/ACP error codes such as `acp_agent_error`
inside `failureCode`. Report which layer produced the code.

## Boundaries and safety

The log and state directory belong to the user's machine. Read it only with the
user's direction for the failure being investigated, quote only the lines needed
for diagnosis, and redact personal or workspace paths when reporting. Never
delete, truncate, rotate, or rewrite `daemon.log` while diagnosing; trimming is
the daemon's own behavior. Do not disable or raise the 1 MiB bound to "keep more
history" — if the needed evidence was already trimmed, say so.

Distinguish evidence sources:

- `logs/daemon.log`: durable local diagnostics (this skill's primary source).
- Daemon stderr/stdout lines (`Morty daemon diagnostic ...`, `Morty relay
  diagnostic ...`): same events, ephemeral console stream.
- Local `wrangler dev` or Chat web output: not evidence of daemon behavior.

## Implement and verify a fix

When the log reveals a defect, state the user-visible slice and add the
repository's required failing Given-When-Then acceptance scenario at the first
supported boundary. The user may explicitly ask for manual verification only;
in that case exercise the behavior with a scratch script outside the repository
and delete it afterward. Preserve typed error codes and sanitized messages at
every boundary, and record new daemon-side failures through the bounded local
diagnostic log so they remain diagnosable after a restart.

Verify as the root `AGENTS.md` "Verification" section describes. Do not
publish or release the CLI unless the user explicitly asks.

## Report findings

Return:

1. State directory, CLI version, and the log file used.
2. The matched diagnostic line(s), time window, and correlation identifiers.
3. The concrete cause chain and which layer produced it (daemon guard, local
   authorization, Agent/ACP rejection, relay connectivity).
4. Fix and verification performed, or the next missing piece of evidence.

Redact secrets, tokens, and personal paths. It is acceptable to report that the
relevant lines were already trimmed by the 1 MiB bound or no diagnostic event
was recorded; it is not acceptable to claim the daemon "has no logs"
without checking `logs/daemon.log`.
