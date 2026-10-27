# Protected inbox release — source-only handoff, 26 October 2026

This supersedes the earlier psql/direct-history operational instructions in PR60.
The exact original foundation bytes/version remain unchanged. No hosted operation,
GitHub administration, dispatch, approval or credential transfer occurred here.

The repository's **public** visibility was verified through read-only GitHub metadata.
Earlier private-repository plan restrictions in the initial runbook are obsolete.
Public repositories can use required deployment reviewers; availability is distinct
from actual configuration. PR60 reports owner-only main updates active and the
stronger protect-main ruleset disabled. This is PR-reported administration state,
not an independent audit of all settings. Read-only ruleset responses may omit
`bypass_actors`; absence never establishes zero bypass permission. Every audit now
requires the verifiable owner-only, commit/bundle/state/environment/ledger-bound evidence described in
[ADMIN_ATTESTATION.md](ADMIN_ATTESTATION.md). Forbidden or incomplete APIs still block.
See [GitHub deployment review](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments)
and [branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

## Authority, protections and immutable input

Backend-only release authority remains **unverified/not transferred** per the existing
cutover runbook. Owner attestation of old token retirement is not independent proof
of all privileged writers being retired. Repository-level PAT read checks are not
deployment approval. No normal Web runtime key is changed.

Before enabling anything, ChatGPT/owner must configure and independently verify:

- Mandatory PR creation, zero required independent approvals and stale-review dismissal, existing required CI gates plus
  `chat-inbox-native-pg17`, zero bypass actors on `protect-main` (`25352225`).
  The only exception is the exact owner-attested existing RepositoryRole
  actor 5 / always list on `main-owner-only-updates` (`25821687`), restricted to
  deletion, non-fast-forward and update rules on main. No PR/CI rule may use it.
  The complete collaborator inventory must establish vivek2310sharma as the sole
  administrator. Only that owner may merge main; contributors submit PRs for owner
  review and merging. Required CI cannot be bypassed. Do not remove other checks.
- Environments named exactly `FairSwapTest` and `FairSwapProd`: required reviewers,
  exactly the owner as a User, owner self-review allowed, administrator bypass
  prohibited and only the `main` branch allowed.
- Distinct environment secrets `CHAT_DATABASE_PASSWORD` and
  `CHAT_RELEASE_AUDIT_TOKEN`; neither name may exist at repository scope. The audit
  identity needs read-only administration/rules/environment and secret-name metadata
  access, never secret values. It must not have source/write/deploy permissions.
  Missing scope, incomplete pagination, 403/404 or absent reviewers remain blockers.
  Omitted bypass lists require explicit owner-approved lists: the exact
  owner-update tuple above, and an empty list for `protect-main`. Unrecognized
  rulesets, changed scope/rule types/actor/mode, or other bypasses are rejected.
- Environment variables `CHAT_INBOX_ENVIRONMENT_ENABLED=true` only after authority
  transfer; `CHAT_WEB_FLAG_OFF_CONFIRMED=true` backed by immutable Web off-state
  evidence; `CHAT_BACKEND_AUTHORITY_RECEIPT` pointing to the reviewed cutover receipt;
  `CHAT_APPROVED_LEDGER_JSON` containing only the freshly reviewed metadata defined
  in the original ledger capture contract. No passwords/tokens belong in variables.

The repository variable `CHAT_INBOX_RELEASE_ENABLED` must remain absent/false by
default. Manual dispatch `deploy` defaults false. Dispatch must target main, and
`approved_sha` must equal the immutable workflow SHA. Checkouts use that SHA with
persisted credentials disabled. All Actions are SHA-pinned; dependency installs
disable lifecycle scripts and precede the credential-bearing step.

The existing non-secret owner-attestation reference remains
`CHAT_RELEASE_ADMIN_ATTESTATION_JSON`, separately scoped to Test and Prod.
It binds the exact workflow commit, bundle, effective main rules, environment
approvals, secret-name scope, all effective ruleset versions and exact allowed bypass lists.
Only the real owner authors the V2 attestation; the GET-only audit checks the
owner identity, complete collaborator inventory and exact unedited statement.
No second administrator or reviewer is required or fabricated. Evidence
expires within 24 hours. No token requires Administration write permission.
No database migration or persistent environment variable is added. The existing
attestation reference now requires the explicitly versioned owner-only V2 schema. See ADMIN_ATTESTATION.md for the exact policy and fresh-proof procedure.

For protection verification only, dispatch `audit_only=true`, `deploy=false`, with
the reviewed `approved_sha`, `bundle_sha256` and both environment ledger hashes.
Both github.actor and github.triggering_actor must be vivek2310sharma for every
manual job, and runtime entrypoints independently enforce the same owner context.
`audit_verify` checks the immutable bundle and automated audit tests without secrets.
`audit_test` and then `audit_production` each require their own protected environment
owner approval and expose only that environment's audit token and non-secret
approved ledger metadata to the audit entrypoint.
They never receive a database password, install the Supabase CLI, import a migration
runner, access a database, change flags or produce a deployment receipt. The initial
`UNAPPROVED_SNAPSHOT` digest output is preparation metadata, never verification. A
missing attestation fails the job. Only the final `status=verified` result is a
successful protection audit; it makes no claim about hosted database/Web flag state.
Both dispatch modes default false and are mutually exclusive. A release still
requires `deploy=true`, `audit_only=false` and every existing default-off release gate.

Compute `bundleHash()` from `scripts/release/protected-inbox-release.mjs` at the
final reviewed commit. `protected-files.json` binds the complete release/security
source set, candidate, legacy contracts and toolchain; dispatch its SHA-256 as
`bundle_sha256`. Separately review the raw Test and Prod ledger JSON SHA-256 values
and supply their corresponding dispatch inputs. Exact metadata bytes are checked
against protected environment variables. These hashes do not replace human approval.

## Native verification and supported migration history

The new secret-free native lane is separate from every existing Backend workflow,
test count and package/toolchain pin. It builds PostgreSQL 17.6 from its pinned
official archive/checksum into an ephemeral private directory. It initializes its
own fixture cluster with loopback/private socket access, never a hosted target.
The existing PR-triggered `chat-inbox-native-pg17` check also runs
`readonly-audit.test.mjs` alongside its existing protected-release suite, without
changing the check name, triggers, permissions or native database test step.

It tests actual role/RLS denial, disabled flags, existing policy-aware send/read
functions, idempotent retry, blocked sends/history, unread/peer cursors, seller
grouping beyond 50 enquiries and tied-cursor drilldown. It also runs pinned Supabase
CLI 2.117.0 `migration up` in an isolated one-file workspace. A deliberately failing
migration must roll back both schema and history. A successful older-version
candidate must apply with `--include-all` while preserving an already-recorded
later version. The native postflight checks the resulting CLI ledger and catalog.
Any unsupported CLI behavior blocks the release verification job.

The operational path **does not insert or repair migration history directly**.
The old `render().apply` remains only for unchanged offline regression fixtures;
its CLI artifact exporter and old apply entrypoints are retired/fail closed.
The protected path renders reviewed identity/full-ledger guards, the unchanged
foundation inner DDL, and catalog/off-state checks into a single execution file with
the original version/name. The supported CLI owns history recording. Source SHA and
rendered execution SHA are distinct and both recorded: CLI history contains its
serialization of the guarded execution, not the earlier one-element raw source.
See [Supabase migration up and repair](https://supabase.com/docs/reference/cli/supabase-migration-up).
Do not use `db push`, raw mixed historical directories, automatic `repair`, fabricated
historical files or a second timestamp for this foundation.

Connection uses fixed `db.<expected-ref>.supabase.co`, database/user postgres, port
5432 and TLS verify-full. Password travels only in process environment; it is never
in a URI argument, generated SQL, receipt or printed subprocess output. All raw
subprocess diagnostics are captured and discarded; errors are fixed generic text.
Direct IPv6 reachability and the CLI's `SUPABASE_DB_PASSWORD` runtime behavior still
require protected native/hosted execution evidence. Do not weaken TLS or silently
switch endpoints/credentials if networking or permissions are unavailable.

## Test before Production, postflight and receipts

The manual release workflow first reruns native verification against the same SHA
and verifies the approved bundle. Only then can the independently reviewed Test
environment job run. The release runner checks live GitHub protection metadata
before any database use, then validates full recent ledger/identity and dependencies,
executes only the isolated candidate via CLI, and automatically verifies PG17,
unchanged noncandidate history, CLI version/name/statements, every function body/
owner/security mode, relevant grants/RLS/indexes, empty safety state, no worker runtime
and all five flags false. No user/message data is exported.

Only success creates an exclusive-create sanitized receipt and SHA256SUMS containing
environment, workflow SHA/run/attempt, source/execution/bundle/ledger/history hashes,
version, flags-off evidence, protection-snapshot/owner-attestation hashes, raw
approved-ledger hash and original/triggering owner identities in V2 receipts.
Artifact v4 uses unique run/attempt names, overwrite
false and 90-day retention. It is immutable within its artifact lifecycle, not
permanent WORM storage; archive the digest/receipt under approved recovery retention.
No credentials, SQL, raw ledger, logs, dumps or message contents are uploaded.

Production depends on successful verification **and Test**, downloads the exact
same-run Test artifact ID, checks file hashes, and revalidates its source SHA, run,
attempt, candidate/bundle hash and successful off-state status. It then requires
its own owner environment approval, credentials, fresh owner-attested ledger and
full postflight. The V2 Test receipt must match the dispatch Test-ledger digest
before any Production audit API or database use. A
skipped/failed Test, foreign run/attempt, changed source or forged receipt is rejected.

The Web flag is never changed by Backend code; independently recorded off-state is
a prerequisite. DB `inbox`, `safety_warnings`, `rich_media`, `meetup_pin` and
`seller_sale_flow` remain false. Activation requires a later independent release.

## Failure, rollback and recovery

Keep default-off gates and Web inbox disabled on any failure. Do not rerun an
ambiguous deployment blindly: existing candidate history/objects stop fresh deploy.
After interruption, a separately protected owner must capture exact ledger and
identity again, compare candidate/source/execution receipt hashes, verify catalog,
all five off flags and unchanged historical versions using automated checks.
If native CLI atomicity holds and neither schema nor row exists, prepare a new
reviewed snapshot and new run. If both exist, treat schema as installed and produce
fresh authorized verify-only evidence; do not replay CREATE statements. This workflow
intentionally does not auto-adopt an installed candidate or issue a replacement
receipt after an ambiguous failure. Missing/partial/foreign history requires a
separately reviewed supported Supabase reconciliation plan, never a silent repair.

Non-destructive rollback first disables Web inbox (or restores prior Web deployment),
then an independently approved Backend operator uses the identity-bound rollback
SQL available from `buildPlan(...).rollback` to disable only DB inbox. Do not expose
credentials in commands. Keep all other flags false, retain objects/messages/read
states/history, and preserve receipts. Unexpected other-flag activation needs a
separately reviewed combined-release recovery. No database down migration exists.

PR58 compatibility: retain exactly version 20261025204922 and original source bytes;
future supported CLI version detection skips it. Review guarded-execution history
and receipts rather than expecting the former custom one-statement serialization.
Worker/scheduler versions remain separate and are not deployed here.

## Local evidence and outstanding gates

The handoff records actual local results. The Windows PG17 installation lacks
postgres.bki. The separate disposable WSL Linux PG17.6/CLI 2.117.0 fixture has since
passed rollback, real CLI history, positive migration, postflight and client RLS
checks; that local result is not hosted deployment or GitHub CI evidence. SQL fixture
emulation in PGlite is separately recorded and is not native/CLI proof.
Protected solo-owner admin/environment settings, live owner attestations, authority transfer, Web off-state,
backup/recovery evidence and actual Test/Prod automated postflight remain unverified.
No GitHub workflow dispatch/administration, hosted change or manual test occurred.

The guarded execution includes a source/ledger-bound marker statement. Postflight
requires that marker in CLI-recorded statements, rejecting a skipped or competing
installation whose version/name alone matches. This is distinct from and recorded
alongside the complete rendered execution SHA-256; it is not a credential.

Audit-correction rollback is a Git revert of the audit/workflow correction, without
changing database state. Any subsequent authorized release remains FairSwapTest then
automated hosted verification, then FairSwapProd, followed only by independently
authorized Web inbox activation. Production acceptance covers existing messages,
participant RLS, migration history, unread/Seen and disabled safety features. Future activation
rollback remains Web flag OFF, then DB inbox OFF, retaining additive schema, history
and messages. This source correction neither dispatches nor authorizes a release.
