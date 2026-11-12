---
metadata:
  change-policy: >-
    Submit changes in a separate documentation-only pull request for review and
    approval. The recommended reviewer is taowen-paraflow.
---

# Morty CLI

Continue Codex, Claude Code and Pi conversations from a browser while the Agent
runs on your own computer. Visit [morty.build](https://morty.build) to connect.

## Requirements and setup

Use Node.js 22.19+ on the 22.x line or 24.20+ on the 24.x line, and an installed,
configured Codex, Claude Code or Pi Agent. Keep the computer awake and online.
Morty's installed package is tested on Linux, macOS and Windows.

Give your coding Agent this prompt:

```text
Fetch https://morty.build/setup.md and complete the Morty setup for me.
You may install missing prerequisites and pair this machine.
```

Read the [setup instructions](https://morty.build/setup.md) before running them.
Open the resulting link in a browser or scan its QR code on your phone.

## Manage your installation

```sh
npx --yes @morty-build/cli@latest status
npx --yes @morty-build/cli@latest start
npx --yes @morty-build/cli@latest restart
npx --yes @morty-build/cli@latest stop
```

Start ensures the daemon is running. Restart launches the version selected by npx.
Stopping retains your pairing, workspace and Agent history. `release` hands idle Agent
sessions back to the terminal without disconnecting Morty. Exit an active terminal
conversation before continuing it in Morty to avoid competing writers.

## Data and support

Conversation history is read from the connected computer; Morty keeps no cloud copy of it.
Traffic passes through a trusted relay; Morty is **not end-to-end encrypted**.
Sharing gives another device permission to view and control sessions, so protect
sharing links and revoke access when it is no longer needed.

See the [product guide](https://github.com/portalcrew/morty/blob/main/README.md)
for full data handling and limitations. For installation help and ordinary bugs,
use [support](https://github.com/portalcrew/morty/blob/main/SUPPORT.md). Report
security vulnerabilities privately through the
[Security tab](https://github.com/portalcrew/morty/security) of the repository; never
put credentials or pairing links in a public issue.

## License

Apache-2.0; see `LICENSE` and `NOTICE` in this package. Bundled third-party
components retain their own terms in `THIRD-PARTY-NOTICES.txt`.
