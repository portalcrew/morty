---
metadata:
  change-policy: >-
    Submit changes in a separate documentation-only pull request for review and
    approval. The recommended reviewer is taowen-paraflow.
---

# Getting help

Start with the [README](README.md), [usage guide](docs/GUIDE.md), and
[contributor guide](docs/CONTRIBUTING.md). The README describes supported Agents,
installation requirements, data handling and known limitations.

For a reproducible bug or a feature request, use this repository's
[issue tracker](https://github.com/portalcrew/morty/issues). Include your
operating system, Node version, Morty version, Agent and version, reproduction
steps, expected behavior and actual result.

Run `npx --yes @morty-build/cli status` and `npx --yes @morty-build/cli logs`
when diagnosing installation problems. Inspect diagnostic output before sharing
it. Remove credentials, pairing links, local paths that identify people, and
private conversation or file contents. Never include an unredacted state directory.

Report vulnerabilities privately using [SECURITY.md](SECURITY.md), not an issue.
For conduct concerns, follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Community support has no guaranteed response time; security reports follow the
response targets in the security policy.
