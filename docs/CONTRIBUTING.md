---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Contributing to Morty

This guide is for developing Morty itself. To connect your Agent and use Morty,
start with the [README](../README.md) and [usage guide](GUIDE.md). Contributors should
use the [glossary](GLOSSARY.md) for Morty's application and Session terminology. See
[AGENTS.md](../AGENTS.md) for engineering rules and [TESTING.md](TESTING.md) for verification.

## Issues and pull requests

Read this guide before opening an issue or pull request.

Pull requests can currently be opened only by repository collaborators with write
access. Everyone else is welcome to open an issue describing the problem or the
outcome they need; the maintainers decide whether and how to implement it.

Compatibility is mandatory unless the human user or maintainer explicitly requires
the particular breaking change. Follow the engineering rules and
[CODE_REVIEW.md](CODE_REVIEW.md). For a changed external contract, include the
affected peers, both mixed-version verification results, and rollout/recovery
consequences in the PR; cite the explicit instruction for any intentional break.
An explicitly authorized Morty contract change does not authorize deletion of
Agent-owned data.

- Write issue titles and descriptions in English.
- Write pull request titles and descriptions in English.
- Write code comments in English.
- Format pull request titles as Conventional Commits:
  `<type>(<optional-scope>): <imperative summary>`. Omit the parentheses when
  no scope is needed, for example `chore: update dependencies`.
- Describe the problem, expected behavior, and relevant reproduction steps in
  issues. For feature requests, describe the user need and desired outcome.
- In pull requests, explain the change, link related issues, and include relevant
  verification results and any limitations.
- Keep Markdown changes in documentation-only pull requests, separate from code,
  configuration, dependencies, and submodule updates.

## Local development

Install Git and the Node version in [.nvmrc](../.nvmrc). Use Corepack to select the
pnpm version pinned in [package.json](../package.json). From your clone:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build:cli
pnpm local-dev --help
pnpm local-dev prepare web-server --background
```

The last command builds the application, starts isolated local services and prints
JSON with `chatOrigin` and `stateDir`. Open `chatOrigin` in a browser. Keep `stateDir`
for status and cleanup; replace `<stateDir>` below with that exact returned path:

```sh
pnpm local-dev status --state-dir <stateDir>
pnpm local-dev remove --state-dir <stateDir>
```

No production Cloudflare credentials or paid model account is needed to build the
workspace or start the local web stack.
Continuing a real Agent conversation requires that Agent to be installed and
configured. See [the local-stack guide](../.agents/skills/chat-local-full-dev/SKILL.md)
for connecting it to the isolated stack. Runtime, protocol, client, and server
sources belong to the same Morty workspace.
Runtime configuration is described in [deployment](deployment.md).

Before proposing a change, run `pnpm lint`, `pnpm typecheck`, and the relevant
commands in [TESTING.md](TESTING.md). New behavior starts with an acceptance scenario
through a supported product boundary. Documentation-only changes do not need new
behavior tests. Follow the [Code of Conduct](../CODE_OF_CONDUCT.md); use
[Support](../SUPPORT.md) to choose the right channel for questions and reports.

## Build and artifact operations

### Web asset CDN

Production builds load content-addressed JavaScript and CSS from an
append-only R2 bucket. Deployments upload new assets before activating
the Worker so an open page can still load its original chunks. Never delete these
objects during ordinary deployment. Provision resources using the independent
Morty production target. Local development uses isolated local resources without
production credentials. Hosted staging and benchmark environments are retired.

### Setup

Users install the Morty CLI and run `morty setup`. The website serves setup
instructions; it does not distribute a separate setup script.

Keep setup intent (identity and workspace selection) separate from daemon-owned pairing
and connection state.
