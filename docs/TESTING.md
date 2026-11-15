---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Testing

What to test and through which boundary is defined in [AGENTS.md](../AGENTS.md#delivery);
when to run which checks is defined in [AGENTS.md](../AGENTS.md#verification).

## Commands

```sh
pnpm lint
pnpm typecheck
pnpm test:web
pnpm test:worker
pnpm test:e2e
pnpm ci:check
```

## Manual checks

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
