# HDR-03 Production forward release package

23 October 2026 — PREPARED FOR REVIEW, NOT INSTALLED, NOT APPROVED FOR RELEASE.
Branch: `release/hdr-03-prod-20261023`.
Starting commit: `54869940042feafd8ea37b1e7390704c316d1872` (merged Backend #48).

## Exact scope

This directory contains ONE new Production forward migration:
`supabase/migrations/20261023160752_hdr03_production_unread_counts.sql`.
CLI 2.117.0 generated the version using local `migration new`. Do not rename it.
The SQL is byte-equivalent after LF normalization to the reviewed #48 candidate
except its header and embedded fail-closed Production preflight. The verifier
enforces this parity. No category, moderation, source-table policy, existing RPC,
notification delivery or worker configuration is changed.

Never deploy the repository's complete historical migration directory, the
candidate directory, Test-only release files, or an imported Test history.
The existing 58 immutable source migrations remain unchanged. This package
does not contain historical migration SQL or Test-only migrations.

## Observed Production baseline and dependencies

Read-only Supabase MCP inspection on 2026-10-23 verified project
`kriuhwppxgxsyyrbjsau` (FairSwapProd), PG 17.6:
57 applied versions, ending `20261022110410`
`production_family_submission_and_human_review_default_off_v1`.
See `production-ledger-20261023.json` for exact version/name pairs.

The first 52 agree with the earlier Production receipt; five later versions are
moderation private foundation/input validation/input lease, the moderation
publication gate and Production family submission/human review. Their presence
is observed history, not permission to change those behaviors. The old 52-version
guard/runbook is historical for this release and must not certify the current DB.

The aggregate was absent. `public.mark_conversation_read(uuid,uuid)` exists as
an invoker wrapper; `app_security.get_account_status(uuid)` exists.
The observed Realtime publication contains `messages` and `notifications`.
The package preflight checks the exact 57 version/name pairs, prerequisite
relations/functions, source RLS, absence of a partial HDR-03 installation and the
publication. It passed in a hosted READ ONLY transaction; no user rows were read.
This is not a complete schema fingerprint or full 57-migration clone rehearsal.

`get_unread_counts()` is invoker/RLS-enforced, no arguments, derives `auth.uid()`,
counts individual inbound messages after the caller's monotonic message tuple,
excludes own messages, counts retained null-sender messages as incoming, and
returns nonnegative safe integer-range counts plus owner unread notifications.
Missing markers mean all incoming messages are unread.
`unread_count_signals` has forced owner-only SELECT RLS, no client writes,
opaque UUID replica key and default replica identity; only INSERT/UPDATE are
consumed. Trigger helper EXECUTE is revoked. Message arrivals/read-marker changes
signal invalidation; notification changes retain the existing notification stream.

## Verification and evidence

Run offline from Backend root:

```sh
corepack pnpm verify:migrations
node releases/production/hdr-03/verify-package.mjs
node releases/production/hdr-03/verify-package.mjs --pglite-module /absolute/local/path/to/pglite/dist/index.js
```

No package dependency was added. PGlite is an existing local Web dev dependency,
used only as an in-memory PostgreSQL runtime; no URL or credential is accepted.
The verifier pins normalized LF hashes, exact one-file migration inventory,
ledger digest and candidate parity. It then loads reduced disposable prerequisites,
the actual immutable notification/communication migrations 10/11, a synthetic
57-entry history, the Production migration, postflight and existing HDR-03
assertions. It verifies wrong-ledger atomic refusal, successful install,
repeat-install refusal and the existing isolation/count/read-state/publication
contract. It is not a clone of hosted Production, hosted Auth or Realtime.

PASS: all 58 immutable files match their canonical manifest. A Windows CRLF
checkout initially failed; restoring canonical Git blob bytes locally resolved
it with no tracked source change.
PASS: offline package/hash/candidate-parity verification.
PASS: disposable PostgreSQL install, negative guards, postflight and HDR-03
security/count assertions. During development the runner's redundant publication
addition and a name[]/text[] postflight cast were corrected before the passing run.
PASS: exact Production metadata preflight in READ ONLY transaction, via Supabase MCP.
NOT RUN: full 57-version disposable-clone rehearsal, hosted post-install checks,
backup/restore rehearsal or genuine two-account Test acceptance.
Owner elected to run Test acceptance separately; see the Web release runbook
`docs/operations/HDR03_PRODUCTION_RELEASE_20261023.md` on
`release/hdr-03-main-20261023`. All release gates below remain open.
No hosted migration, schema/data write, deployment or GitHub administration occurred.

## Backup and recovery preflight — operator checklist, not execution authority

Before any separately authorized installation, the owner must record:

1. Verified project/environment and operator identity, release window, approved
   Web/Backend source SHAs and migration hash from `manifest.json`; no secrets
   in evidence. Re-fetch the actual ledger and rerun the read-only preflight.
   Any version/name or object drift is STOP, requiring a new reviewed package.
2. Current backup/PITR availability, latest successful recovery point UTC, retention,
   encryption/location, operator access, explicit RPO/RTO and restore owner.
   Do not assume the plan includes PITR. Keep dumps/credentials outside Git.
3. A successful restore rehearsal into an isolated disposable environment,
   validating Auth/roles/RLS, source messages/read markers/notifications and the
   relevant moderation/category invariants. Database backups do not establish
   Storage object recovery; document the separate recovery path and scope.
4. A full schema/contract rehearsal using that authorized current Production clone,
   applying only this forward delta. Rehearse failure/timeout atomicity and the
   reviewed containment/forward-fix. This local reduced fixture is insufficient.
5. Owner-run genuine Test Auth/Realtime acceptance, including same-owner multiple
   tabs, cross-owner isolation, reconnect, sign-out and session switch. Ensure a
   supported fixture cleanup path; existing Web chat has no delete control.
6. Independent security/CI approval and the remaining backend exclusive-release
   ownership gates. This repository adds no deploy workflow or release credential.

## Installation handoff — future separate authorization required

Do not run hosted commands in this task. The owner/release operator must choose
and independently review the installation mechanism and ledger recording before
approval. A delta-only Supabase CLI workspace may reject missing remote historical
files; do NOT bypass this with migration repair, fabricated applied versions or
the raw mixed-environment baseline. The release package deliberately omits that
history. If a CLI-managed route is chosen, reconstruct/verify the exact approved
57-version workspace privately from authoritative Production artifacts, outside
this package, then add only the one approved delta and inspect its dry-run.

The chosen mechanism must execute the reviewed transaction and record version
`20261023160752` exactly once on success. A ledger entry must never claim a failed
or partial migration. The SQL itself does not manually write migration history.
Expected ledger after installation: original exact 57 plus this version = 58.
This count is unrelated to the immutable mixed source's coincidental count of 58.

Post-install: verify exact ledger delta, run `postflight.readonly.sql`, and compare
pre-existing communication policies/grants/indexes/functions and category,
publication and moderation settings to the captured pre-release snapshot.
The postflight checks aggregate permissions/invoker mode/no overload, signal RLS,
payload/replica identity/client-write denial, trigger/helper boundaries, owner policy
and exact publication membership. Then perform genuine authenticated functional
acceptance, including caller-only counts and Realtime delivery. Never simulate
identity with privileged SQL and call it hosted Auth acceptance.
Backend-first installation avoids Web's missing-table subscription gap; missing
chat counts remain unknown until the RPC exists. Decide rollout only after review.

## Containment, rollback and forward-fix

Before commit, any migration error rolls back the transaction; locks have 5s and
statements 30s limits. Confirm no new ledger entry or HDR-03 objects before retry.
Do not repeatedly retry without diagnosing lock contention or prerequisite drift.

After a committed installation, prefer reverting Web to its last approved version
and a separately reviewed NEW forward migration. Do not edit/delete an applied
migration, reverse the ledger, change existing read cursors, remove messages or
notifications, or undo the 57-version baseline. Preserve the new signal table for
diagnosis until the fix is reviewed.

If triggers block normal message/read writes, the operator's separately approved
containment forward migration should drop only `hdr03_message_arrival` on messages,
`hdr03_read_state_insert` and `hdr03_read_state_update` on conversation_read_states.
This restores pre-HDR signal behavior; counts then refresh on navigation/reconnect
and successful local read actions. Capture the incident and degraded Realtime state.

If the aggregate itself is unsafe, a separately reviewed forward removal/revoke
must make Web fail closed/unknown, then repair the implementation. Revoking only
EXECUTE produces a permission error (unknown counts), not the missing-RPC
notification fallback; explicit notification-only fallback requires removing the
no-argument RPC after dependency review. Never widen RLS or grants to make it work.
Do not drop source tables or use CASCADE. Removing new helper functions/publication
membership/table is an optional later reviewed cleanup only after all three
triggers and consumers are accounted for.

For broader data loss, freeze affected writes under the incident owner's authority,
recover the verified backup to isolation, reconcile legitimate writes after the
recovery point, validate security/compatibility and seek explicit cutover approval.
A full Production restore can lose unrelated user writes and is not an automatic
rollback for this additive feature.

## Review follow-up: offline CI gate

The path-filtered `.github/workflows/hdr-03-production-package.yml` runs on PR
updates to this package, its reviewed candidate, SQL fixtures, source migrations
10/11 or prior Production receipt. It runs this package's verifier for migration
and ledger hashes/parity, wrong-ledger atomic refusal, successful install,
repeat-install refusal, postflight and the existing security/count assertions.
Actions are commit-pinned, token permission is Contents read, checkout credentials
are not persisted, and no hosted secrets or deployment mechanism are used.

The setup step acquires exact PGlite 0.5.8 into runner temporary storage with
lifecycle scripts disabled. The PostgreSQL test then runs in a fresh network
namespace with an empty credential environment and an in-memory database.
Network-isolation failure fails the job. No repository dependency, migration,
manifest, ledger or hosted database is changed by this follow-up.

Local package and disposable PostgreSQL checks pass on Windows, including with
credentials removed from the child environment; YAML/permission/trigger checks
also pass. The Linux namespace step and GitHub job outcome must be verified in
Actions on the pushed commit. This adds no proof of hosted Auth/Realtime acceptance,
the full Production-clone rehearsal or backup/restore readiness.

This follow-up changes only this README and
`.github/workflows/hdr-03-production-package.yml`.

## Initial release package changed files

- `README.md`
- `releases/production/hdr-03/README.md`
- `releases/production/hdr-03/manifest.json`
- `releases/production/hdr-03/postflight.readonly.sql`
- `releases/production/hdr-03/preflight.readonly.sql`
- `releases/production/hdr-03/production-ledger-20261023.json`
- `releases/production/hdr-03/supabase/migrations/20261023160752_hdr03_production_unread_counts.sql`
- `releases/production/hdr-03/verify-package.mjs`
