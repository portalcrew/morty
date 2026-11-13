---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Testing

## Commands

```sh
pnpm lint
pnpm typecheck
pnpm test:web
pnpm test:worker
pnpm test:e2e
```

Run only related suites during development. `pnpm ci:check` reproduces combined
static validation and client tests when diagnosing CI.

## Test boundaries

Web tests exercise visible user workflows in happy-dom. Worker tests enter through
production HTTP, WebSocket, and storage boundaries. Browser E2E covers happy-path
conversation and setup journeys.

Morty Web, Worker, and browser suites run the production daemon through the real
Morty WebSocket endpoint. Tests inject a stateful controlled ACP harness through
the daemon's Agent dependency argument; the single Worker, internal clients, daemon behavior,
and transports remain real. Each fixture owns pairing and cleanup of the
resources it creates.

Follow [AGENTS.md](../AGENTS.md) for scenario and fake-provider rules. Exercise visible
controls in Web tests and production HTTP/WebSocket boundaries in Worker tests.
The controlled ACP harness establishes Morty behavior across the production daemon,
not compatibility with a named Agent. Real Agent compatibility requires the real
executable and production adapter; a controlled provider can supply deterministic
model responses without coding-plan credentials. Do not infer compatibility from an
Agent label on a controlled peer.

Visual layout checks remain manual. Record manual verification
results in the relevant pull request and attach screenshots there. Do not commit
one-off reports or screenshots to the repository. Keep durable behavioral
guarantees in executable tests.

## Independent distribution acceptance

Test the exact packed Morty archive through installation and public CLI behavior
on the declared operating systems and Node versions. Exercise fresh setup,
pairing, conversation, attachments, history, and reconnection with real services,
transports, and the production daemon. A controlled ACP Agent does not establish
compatibility with a vendor Agent.

Exercise interrupted installation and update through the supported installation
boundary. Verify local IPC authentication, resolved-path ownership, and rejected
cross-environment credentials. Publication is gated on the complete acceptance
record for the exact archive; publishing a candidate is not an acceptance test.
