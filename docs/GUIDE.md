---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Using Morty

This guide covers connecting your coding Agent, continuing conversations from a
browser, and understanding history and recovery. For the product overview, see the
[README](../README.md). To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Get connected

Open [morty.build](https://morty.build) and copy the setup prompt into the coding
Agent on your computer. Open the link it returns, or scan its QR code on your phone.
Keep the connected machine awake and online; the Agent runs in that environment.

## Conversations across screens

An Agent may be working on your computer while you are somewhere else. You need a
convenient place to check its progress, answer a question, give the next instruction
and see the result without returning to the terminal where the work started.

Morty makes that a browser chat experience. Connect a computer and select an
installed Agent for the task. In its conversations, you can send instructions,
queue follow-ups, stop work, respond to permission requests and view available
history, files and generated images. Only browsers with access to that computer
can use its conversations.

You should be able to open the same conversation in another browser, catch up on
instructions sent elsewhere and continue participating. New output should appear
promptly even during a long answer. Displaying each update should process the new or
changed content without repeatedly rebuilding the entire turn; opening or reconnecting
may require a separate catch-up step.

Morty includes the local Runtime, relay, and browser experience. Available operations
depend on the Agent and configuration; unavailable capabilities or history must be
clear to the user. Another application may use the same installed Agent; Morty must
not write to an Agent conversation another writer is using. Stop or release the
current writer before continuing it elsewhere.

## Data ownership and recovery

Live output favors responsiveness over guaranteed delivery. Disconnects and restarts
can leave gaps; catch-up depends on native Agent history. Morty keeps no cloud
copy of conversation history. Agent-owned history stays in the Agent's directories;
Stopping Morty preserves it.

Morty's state directory is `~/Library/Application Support/Morty/v3` on macOS,
`%LOCALAPPDATA%\Morty\v3` on Windows, and `$XDG_STATE_HOME/morty/v3` (or
`~/.local/state/morty/v3`) on Linux. An absolute `MORTY_STATE_DIRECTORY` overrides
it. Pairing and local credentials belong to this installation; Agent-owned history
remains in the Agent's own storage.

Use `npx --yes @morty-build/cli@latest start` to ensure the daemon is running.
Use `restart` with the same command prefix to launch the selected release, or
`stop` to leave the machine offline. `status` reports the CLI and daemon versions.
Each machine installation keeps one pairing. The browser remembers each paired
machine's access separately and opens the selected identity when you switch computers.

## Command reference

Run each command as `npx --yes @morty-build/cli@latest <command>`. Add `--help` to a
command to see its options; that output is the authoritative description.

| Command | What it does |
| --- | --- |
| `setup` | Connect this Agent session and print a browser handoff link and QR image |
| `start` | Ensure the daemon is running and activate the current pairing |
| `stop` (alias `quit`) | Stop the daemon and every active Runtime |
| `restart` | Restart the daemon using this Morty CLI release |
| `release` | Release idle Agent sessions so the Agent's own app can continue them |
| `revoke-all-access` | Revoke this computer's previously shared links and browser access without stopping its tasks |
| `status` | Show the CLI and daemon versions |
| `agents` | Show detected, missing, and integration-ready Agents |
| `logs` | Print the local daemon diagnostic logs for a bug report |

For hosting, see [deployment](deployment.md).
