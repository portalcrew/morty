---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Security Policy

Morty gives a browser a window into a coding Agent running on someone's own
computer. Session traffic, pairing, and shared access are the parts of that path
most worth scrutiny, and we would rather hear about a problem from you than from
an incident.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub: open this repository's **Security** tab and
choose **Report a vulnerability**. Only the maintainers can see the report. Do not
post a report in the retired product repository.

Helpful things to include:

- what an attacker can do, and what they need in order to do it
- the smallest reproduction you have, including the Agent (Codex, Claude Code, or Pi)
  and whether the connected machine was online
- affected versions or commit, and the `@morty-build/cli` CLI version if setup is involved
- any sharing link, pairing, or revocation step that is part of the path

Please do not include live credentials, pairing tickets, or customer data in a
report. Describe where they appear instead.

## What to expect

- We acknowledge a report within **3 business days**.
- We send an initial assessment, including whether we consider it in scope, within
  **10 business days**.
- We keep you updated while a fix is in progress, and we credit you in the advisory
  unless you ask us not to.

## Trust model

Morty is designed for one person reaching their own computer. Knowing what it
trusts by design helps separate a vulnerability from intended behavior.

- **A device with access controls the Agent.** Whoever holds an unused sharing
  link, or a device that joined through one, can view and control the computer's
  sessions, and so can ask the Agent to do anything the Agent may do on that
  computer. Codex sessions start in **Full access** (no approval prompts and no
  sandbox) unless another mode is chosen. Claude Code follows the computer's own
  Claude Code permission settings, and its approval requests are answered from the
  browser.
- **The computer's own credential stays on the computer.** Setup saves it in a
  state file readable only by the operating-system account that ran setup. It does
  not expire. Revoking all access replaces it and ends every other credential,
  sharing link and browser device of the computer.
- **Session payloads are end-to-end encrypted (E2EE).** The browser and the local
  daemon hold the payload encryption secret; the relay forwards ciphertext and
  still sees routing metadata. Pairing delivers encryption access in a URL fragment,
  not in a request to the relay. Protect sharing links and authorized devices. See
  [What Morty does with your data](README.md#what-morty-does-with-your-data).
- **What E2EE protects, and what it does not.** It protects Session payloads from a
  relay that stores and forwards them, from its logs, and from anyone who observes
  traffic without the secret. The daemon rejects replayed or altered messages. It is
  not designed to protect against the following:
  - **A relay that serves malicious code.** The web application, and the helper that
    setup instructions give a remote Agent, are delivered by the same service that
    relays traffic. A compromised service could deliver code that reads the secret.
  - **Exposure of the secret.** One secret per Computer is shared by every authorized
    device, and Morty does not derive a fresh key for each connection. Someone who
    obtains it can read ciphertext they have recorded and create messages the daemon
    accepts. A device that joined keeps the secret in its browser storage until
    Morty running there finds its access gone or the storage is cleared.
  - **Ending one device's access.** Disconnecting a device, or the end of a sharing
    term, stops the relay from serving that device but does not change the secret.
    Revoking all access gives the computer a new identity and a new secret.

A path that gives someone access they were never given, or keeps access after it
was revoked or expired, is in scope. Using access that was given, including
running commands through the Agent, is not.

## Scope

Security fixes target the latest published `@morty-build/cli` release and current
Morty services. Earlier pre-launch releases and saved state are unsupported under
the documented [launch reset](README.md#installing-the-launch-release). Include
your exact version even if you are unsure whether it is supported. Do not assume
that a package update alone revokes exposed credentials; report the exposure so
revocation and recovery can be assessed.

In scope:

- this repository and the deployed application at `morty.build`
- pairing, sharing links, access revocation, and session authorization
- the setup instructions served at `morty.build/setup.md`

The internal client library, relay and local Runtime are part of this product and
use the same reporting channel.

Generally out of scope:

- findings that require an already-compromised connected machine, or an attacker
  who already has the operating-system account that ran setup
- missing hardening with no demonstrated impact, and automated scanner output
  without a working path to exploitation
- denial of service through traffic volume

## Testing against your own setup

Test against computers you control. Do not attempt to reach other
users' sessions, and do not run tests that degrade the service for other people.
If a test accidentally gives you access to something that is not yours, stop, and
tell us what happened in the report.
