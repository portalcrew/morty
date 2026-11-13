---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Morty releases and deployment

Morty owns one workspace and one public npm distribution, `@morty-build/cli`.
Protocol, Runtime, relay, and storage code are internal to Morty.
The only hosted application environment is production in the Morty Cloudflare
account. Development, integration and performance checks use isolated local or
CI services; there is no permanent staging or benchmark deployment. Local
services must not use production credentials or silently fall back to production.

## Cloud deployment

Production is one `morty-production` Worker at `morty.build`. It serves the website,
identity and computer management APIs, pairing and Session traffic. Each computer
owns its state and Runtime connection in a `ComputerRelay` Durable Object. Relay
is an internal responsibility of this deployment, not a separately deployed
service. The ComputerRelay Durable Object owns computer state; R2 holds immutable
web assets.
Conversation attachments remain on the connected computer. Local and CI stacks
use the same topology with isolated storage.

The release pipeline builds the checksummed portable cloud artifact together with
the CLI archive, validates its source revision and pinned destination, then
archives it. Pull requests build without deployment secrets. Ordinary production
publication is owned by the Morty CLI workflow after a merge to main; a separate
cloud workflow must never automatically deploy a competing build. The Morty Cloud
workflow only recovers an accepted archived release.

The `morty-production` deployment environment supplies `CLOUDFLARE_API_TOKEN` and
`MORTY_SESSION_SIGNING_SECRET` individually. The signing secret authorizes short-lived
Session credentials and never enters browser code or stored account records.
Internal calls need no separate service credential. Secret values are assembled
in a private short-lived file and removed after deployment.

Use a Cloudflare Account API Token for CI/CD so deployment authority belongs to
the Morty account independently of its creator's user membership. Limit it to the
required Workers deployment and R2 asset-upload permissions in the Morty account
and set an expiration. Scope Workers access to the production Worker where the
deployed API supports it. R2 uploads currently use the Cloudflare REST API; its
account-level storage permission must stay in the Morty-only account. Bucket-scoped
object credentials require a separately verified S3 upload path.

Ordinary deployment does not need DNS, zone administration, member management
or API-token provisioning permissions.

Deployment and restore verify account ownership, active status and a valid future
expiration before making changes, and warn when expiry is within 30 days. The
Morty production operator owns rotation and must have access to both Cloudflare
account tokens and the GitHub deployment environment. Rotate the environment
secret before expiry and verify a deployment before revoking the replaced token;
never use a personal User API Token or a Global API key as a fallback.
Never log credentials.

Morty enforces identity, sharing, pairing and authorization at the owning execution
boundary. Preserve active computer and Agent data; the migration history of every
bound database is immutable.

Deployment checks account authority, artifact identity, required secrets and the
destination resources before writes. Production refuses to activate an installer until the exact
Morty npm version exists with the accepted archive integrity. Upload immutable assets before changing the Worker.
A restore uses the archived bytes and source revision, validates current Durable
Object migration history, and never rolls persistent data backwards.

Wrangler updates supplied secrets additively. Cloudflare cannot return stored
secret plaintext; obtain it from its owner or replace it with a new signing secret. Rotating the signing secret ends
existing Session access; Runtime and owner credentials have separate lifetimes.

## Automatic release sequence

Build each release once. The merge queue runs the complete source validation,
security scan and browser acceptance on the exact commit that main becomes. It
assigns that commit's stable patch version, builds one CLI archive and its matching
cloud artifact, and tests the archive on every supported OS/Node combination. Pull
requests exercise the same gates without publication credentials, testing the
archive on Linux across the supported Node versions; the merge queue adds macOS
and Windows before anything reaches main.

Release only the newest main commit, and only when it changes something that ships
since the production release. Documentation, repository automation and tests never
reach a release artifact, so a change confined to them publishes nothing. An older
commit's changes ship with the newest one instead of queueing a release of their
own. The release workflow publishes the archive the merge queue
accepted instead of rebuilding and retesting the same source; a commit without an
accepted archive is built and validated by the release workflow before
publication.

The sequence is production preflight, npm publication and integrity verification,
cloud deployment and verification, then source tag and GitHub Release. Publication
must pass the exact-archive acceptance gates first. Keep the existing installer
available until the accepted npm archive exists; then activate the matching cloud
artifact and verify health, assets, pairing and Session access.

Database migrations are never reversed. For ordinary
updates, a failed deployment restores the previous Worker only when Durable
Object lifecycle history permits it. Creation or deletion of a DO namespace
requires forward repair; do not claim an ordinary version rollback restored it.
A failure after npm publication leaves an incomplete release: npm publication
cannot be undone by restoring a Worker.

Release versions are derived from a committed stable-version baseline and the
number of first-parent main commits since its recorded source revision. The same
commit therefore always selects the same version, including after a failed run.
The package manifest in source records the baseline; release builds apply the
computed version without a bot commit or protected-branch bypass. Failed or
non-published commits can leave patch-number gaps. Minor/major changes require a
reviewed baseline update, and do not authorize protocol incompatibility.

Production runs queue serially, including manual recovery. An older release must
not overwrite a newer published version. Preserve the immutable CLI and cloud
artifacts from the original run: retry failed jobs on that run, rather than
rebuilding published bytes. Missing, expired or inconsistent artifacts stop the
release. The workflow never silently replaces a published npm version or moves a
release tag. Build and deployment records bind version, source revision and
archive integrity; GitHub Release assets retain the accepted artifacts beyond
Actions artifact retention.

Every failed gate stops dependent stages. When the automatic Worker restoration
itself fails, the job reports it and production keeps the unverified Worker until
recovery. npm and Cloudflare are
independent systems, so a failure after npm publication cannot undo publication;
it leaves an incomplete release with no final GitHub Release. Inspect the failing
job, correct the operational cause, and rerun failed jobs with the original
artifacts. Do not unpublish or repack that version. If code changes are necessary,
merge a correction and release a newer version. Cloud deployment can partially
complete before a failure; use the recorded component versions and migration
checks for recovery, never reverse database migrations automatically.

Manual recovery accepts only an archived main-branch run that completed the full
publication/deployment chain and contains the consolidated single-Worker format. It uses
that run's exact cloud artifact and independently verifies the published CLI
integrity. Recovery intentionally changes the deployed version; it does not
republish npm or rewrite the existing GitHub Release. Release automation and
recovery share a production lock.

## CLI publication

Build and pack once, then test that same archive across supported systems and
Node versions.
Record its source revision and integrity. Do not publish a public prerelease to
bypass the acceptance gates.

The Morty CLI workflow publishes only from main after its checks pass and the
complete product acceptance and review are finished. Configure npm Trusted
Publishing for this repository, `morty-cli.yml`, and the `morty-npm` environment.
First-publication authorization must be established separately; scope membership
alone does not configure a publisher. Verify registry integrity after publication.

This repository and the CLI package are public, and publication uses npm Trusted
Publishing with provenance enabled. Keep provenance enabled for new releases.
OIDC authorizes the configured publisher; npm provenance separately links the
published archive to its source repository, revision and publishing workflow.
Archived release records and checksums remain useful acceptance evidence, but
are not substitutes for a public provenance attestation. Making an old release's
source repository public does not retroactively add provenance to that version.

To inspect a release, open that exact version of `@morty-build/cli` on npm and
follow its provenance details. Check that the repository is `moxt-ai/morty`, the
workflow is `morty-cli.yml`, and the source revision matches the accepted release.
In an isolated directory, install the exact version with `npm install
--ignore-scripts @morty-build/cli@<version>`, then run `npm audit signatures` with
a current npm CLI to verify registry signatures and available attestations.
Check that the selected CLI version has provenance: a successful audit of registry
signatures alone does not establish that every installed package has an attestation.
See npm's [provenance verification guidance](https://docs.npmjs.com/viewing-package-provenance/).

Provenance establishes origin, not that the code or its dependencies are safe.
It does not replace code review, exact-archive acceptance or deployment checks.
Public npm provenance requires public source; if repository visibility changes,
reassess publication and recovery rather than describing an unsigned release
record as provenance.

Activate matching cloud and CLI artifacts, then verify fresh installation, pairing,
conversation, attachments and reconnect. Preserve accepted release archives and
retained data for recovery. Never replay old writers against new schemas.
Recovery restores an accepted matching cloud/CLI
release and uses fresh pairing when installation generations differ. Agent-owned
data remains independent.
