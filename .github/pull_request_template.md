---
metadata:
  change-policy: >-
    Submit changes in a separate documentation-only pull request for review and
    approval. The recommended reviewer is taowen-paraflow.
---

## Problem and result

Describe the user-visible problem and what a user can do after this change.
Link related issues and explain any relevant limitations.

## Verification

List the checks actually run and their results. For behavior changes, identify the
Given-When-Then acceptance scenario and the supported boundary it exercises.
For documentation or unchanged behavior, explain why new tests are not needed.

## Compatibility and recovery

Identify affected clients, servers, Runtimes and persisted data. Include evidence
for both mixed-version directions and the rollout/recovery plan, or explain why
compatibility is not applicable. Cite the human authorization for any intended
break.

## Review checklist

- [ ] I read `docs/CONTRIBUTING.md`, `AGENTS.md`, and `docs/CODE_REVIEW.md`.
- [ ] The change follows the design priorities in `AGENTS.md`.
- [ ] Markdown changes are in a separate documentation-only PR.
- [ ] Reports and logs contain no credentials or private conversation data.
