---
metadata:
  change-policy: >-
    Submit changes in a separate documentation-only pull request for review and
    approval. The recommended reviewer is taowen-paraflow.
---

<div align="center">

# Morty

**English** · [简体中文](README.zh-CN.md)

### Step away from your desk. Keep work moving.

Continue Codex, Claude Code, and Pi conversations from any browser.

[Open Morty →](https://morty.build) · [Get connected](#one-prompt-then-pick-up-your-phone) · [Contribute](docs/CONTRIBUTING.md)

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

<img src="docs/assets/readme-accent.svg" width="320" height="40" alt="" />

</div>

Your agent is working on your computer. Morty puts the conversation on your phone,
tablet, or another screen, so you can check in and give the next instruction wherever
you are.

## Stay in the loop

- **See work as it happens.** Follow live replies and tool activity, then open files
  and generated images from the conversation.
- **Keep things moving.** Send instructions, queue follow-ups, stop a turn, or answer
  supported approval requests.
- **Switch screens, keep the context.** Return to your connected conversations from
  another browser and pick up where you left off.

## Your agent. Your setup.

Your projects, tools, and signed-in agent stay on the connected machine. Morty gives
you a browser view into that environment. Open your connected conversation from
another screen. Share access when you want someone else to join, and revoke it
when you're done.

## One prompt. Then pick up your phone.

Open [morty.build](https://morty.build) and copy the setup prompt, or paste this
into your coding agent:

```text
Fetch https://morty.build/setup.md and complete the Morty setup for me.
You may install missing prerequisites and pair this machine.
```

Open the link it returns, or scan the QR code on your phone. No mobile app required.

Setup is a document your agent reads, not a black box:
[setup.md](https://morty.build/setup.md) is public, and it tells your agent to
download the installer to a private temporary directory and inspect it before
running it. Read it yourself before you paste the prompt.

## What you need

- One of **Codex**, **Claude Code**, or **Pi**, installed and signed in on your computer
- **Node.js 22.19+ (22.x) or 24.20+ (24.x)**
- The connected machine **awake and online**. Morty is a window into a session running
  on your computer, not a cloud sandbox. When the computer sleeps the session pauses with
  it, and the browser shows no history until it reconnects.

## Stopping Morty

`npx --yes @morty-build/cli@latest stop` stops Morty and retains your pairing and Agent history.

## Known limitations

- **Exit a terminal session before you continue it in Morty, and resume it again when you
  come back.** Morty picks up the turns you make after `claude --resume`, `pi --continue`,
  or `codex resume`. A terminal session that stays open keeps its own copy of the
  conversation: it does not see what you send from Morty, and with **Claude Code** or
  **Pi** its next message forks the conversation.
- **Codex lets one app write to a thread at a time.** If the terminal reports
  `thread ... already has an active writer` after you used the thread in Morty, run
  `npx --yes @morty-build/cli release`. It hands idle sessions back without disconnecting Morty; continuing
  in Morty reopens them.

## What Morty does with your data

- **Your conversation is read live from your machine.** The browser keeps a session
  ID and title; the history itself is fetched from the daemon on your computer each
  time you open a session. When that computer is offline, the history is not
  available in the browser. That is the design, not a cache miss.
- **No cloud copy of your history.** Morty reads conversation history from the
  connected machine and never stores it in the cloud.
- **Session payloads are end-to-end encrypted (E2EE).** Your browser and the daemon
  on your computer encrypt and decrypt session payloads. The Morty relay forwards
  ciphertext without the payload encryption secret. Routing metadata remains
  visible to the relay; E2EE does not hide all connection information.
- **Your machine's identity stays on your machine.** Setup stores this computer's
  Morty identity in your user's local application data directory, protected by
  filesystem permissions. It is not synced between computers, and each computer has
  its own.
- **Sharing is explicit, time-limited and revocable.** A sharing link opens Morty on
  one device, once, within 10 minutes. That device can view and control sessions in
  the computer for the term chosen when sharing (1 hour to 30 days; a day by default),
  including asking the Agent to run commands and change files. Codex sessions start
  with full access to the computer, so treat the link like a password. **Devices**
  lists every device with access and disconnects any of them; to withdraw everything
  shared from a machine, tell your agent: *"Revoke all links I previously shared from
  this machine."* That also replaces the machine's own credential, so a copy of it
  stops working. Chat windows open
  on a disconnected device close at once, or within 15 minutes if the relay cannot be
  reached.
- **Morty records roughly where a device joined from, never its address.** When a
  browser opens a sharing link, Morty keeps the city and country Cloudflare locates
  the connection in, so you can recognize your devices. It does not store IP
  addresses.
- **Restart to update Morty.** Run `npx --yes @morty-build/cli@latest restart`
  to launch the current release. Use `status` to see the CLI and daemon versions.
- **The website reports errors and performance diagnostics to Sentry.** URL query
  strings, user information, cookies, request headers, and request bodies are removed
  from these reports. Morty's server logs setup progress (instructions fetched,
  identity created, link issued, link opened), recording only the step and whether
  a browser or an agent made the request. A bug report you choose to send also
  includes diagnostics from your browser and your computer's daemon, plus any images
  you attach.

## Leaving

Morty does not hold your session hostage. Run `npx --yes @morty-build/cli stop` and every Morty session
on that computer closes while pairing and the agent's own history stay intact. Pick
the conversation back up natively:

| Agent | Resume |
| --- | --- |
| Codex | `codex resume` |
| Claude Code | `claude --resume`, or `claude --continue` for the most recent one |
| Pi | `pi --resume`, or `pi --continue` for the most recent one |

`npx --yes @morty-build/cli start` reconnects Morty later. To hand idle sessions back to the terminal
without disconnecting Morty, run `npx --yes @morty-build/cli release` instead.

## Security

Found a vulnerability? Please report it privately — see [SECURITY.md](SECURITY.md).
Don't open a public issue for a security problem.

---

Morty owns its browser, cloud services, and local Runtime in this repository.

[Contributing](docs/CONTRIBUTING.md) · [Testing](docs/TESTING.md) · [Usage guide](docs/GUIDE.md) · [Deployment](docs/deployment.md) · [Security](SECURITY.md)

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE).
