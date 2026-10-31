# FSW-SEC-003 — Recovery and deployment-authority evidence gaps

## Current owner-authorized Free-plan backup waiver (FSW-SEC-003 only)

The FairSwap owner explicitly accepts proceeding **without provider-managed automatic backup and backup-dependent restore verification** on the Free plan for only the pinned search-hardening candidate `20261031110408_fsw_sec_003_public_search_hardening.sql`, raw SHA-256 `b9746cdf49299af84bbbfc5f79b51dd7d67a737202a2d54c55f8743fc15770bd`, and only FairSwapTest (`wpppxlnbzqynvhpeuavd`) followed by FairSwapProd (`kriuhwppxgxsyyrbjsau`). See the [owner's recorded acceptance](https://github.com/vivek2310sharma/FairSwap-Backend/pull/75#issuecomment-6549137816). **No backup, recovery or restoration is claimed to have passed. Risk includes unrecoverable data loss and downtime.**

The release orchestrator records this limited waiver as `backupRecovery.status: WAIVED_BY_OWNER` in sanitized receipts and requires the exact same scope in the authenticated Test receipt before Prod. No provider backup listing is requested by this protected release. This supersedes only the backup and backup-dependent restore prerequisites in older audit notes below; it does **not** authorize migration deployment or affect the independently dispatched read-only metadata-audit workflow.

All other checks remain: explicit owner-only GitHub dispatch and protected environment approvals; exact CI/source/SQL checksum, genuine per-project migration-history fetch/dry-run, TLS and PG17/CLI pins, RLS/ACL/catalog integrity, effective Data API exposure, complete privileged-writer inventory and independently authenticated Backend-exclusive deployment authority. The existing authority validator still checks evidence fields/digest *format* without independent provenance verification; **this unwaived proof gap must be resolved before any hosted migration**. Neither per-environment authority record has been provided.

The owner waiver is recorded here for the source change only. The protected release remains disabled pending the other gates, and no migration or hosted write is authorized by this documentation.


**Audit checkpoint:** 31 October 2026  
**Source baseline:** FairSwap-Backend `main` at `1753606d9ad7f412aaee775f64ba08da7cc0fda9`  
**Status:** **BLOCKED** — documentation/evidence inventory only; no hosted write, release dispatch, waiver, or recovery attestation.

This document records what is evidenced in the repository and the gaps identified by the FSW-SEC-003 handoff. A referenced source record is not automatically independently verified current operational proof. Do not fabricate a `PASS` receipt from this document.

## Evidence available

| Item | Source record | What it does — and does not — establish |
| --- | --- | --- |
| Test / Production scoped token isolation | [Backend scoped-token check](../../../docs/operations/BACKEND_SCOPED_TOKEN_CHECK.md); [Test run 39126378994](https://github.com/vivek2310sharma/FairSwap-Backend/actions/runs/39126378994) and [Production run 39126417831](https://github.com/vivek2310sharma/FairSwap-Backend/actions/runs/39126417831) | Owner-documented successful read-only `GET /v1/projects/{ref}` and rejection by the opposite project on 18 October 2026. Does **not** establish `database:read` / `backups_read`, PostgREST config reads, `supabase link`, migration write permissions, or protected release authority. |
| Older personal access tokens | [Scoped-token check](../../../docs/operations/BACKEND_SCOPED_TOKEN_CHECK.md) and [source-ownership audit](../../../docs/operations/POINT1_SOURCE_BOUNDARY_AND_OWNER_ACTION.md) | Revocation is **owner-attested**. This is not independently provider-authenticated invalidation, nor proof all privileged writers are retired. |
| Release-specific recovery exceptions | [Chat V2 protected-release runbook](../chat-v2-inbox-only/PROTECTED_RELEASE.md) and release-specific Ratings source/runbooks | Prior Chat and Ratings backup/approval exceptions are scoped to their respective releases. They are **not** authorization to waive FSW-SEC-003's separate restore/authority requirements. |
| Reviewed search release gates | [FSW-SEC-003 README](README.md), [protected release](../../../scripts/release/fsw-sec-003-release.mjs), [validator](../../../tests/fsw-sec-003/release-gate.mjs) | The source contains fail-closed validation and SQL integrity checks. It is not successful hosted preflight/postflight or restore evidence. |

At this audit checkpoint, **no** `releases/candidates/fsw-sec-003/recovery/FairSwapTest.json` or `FairSwapProd.json` is present in tracked Backend `main`. No successful automated restore record was located in the reviewed source records. This is not a claim that the provider has no backup; it is a statement that acceptable release evidence has not been produced.

## Missing prerequisites — independently required for each environment

1. **Backup metadata:** confirm the existing token can use the read-only Supabase backup listing (`database:read` / `backups_read`); this permission is **UNVERIFIED**, even though project-read isolation passed.
2. **Recoverability:** verify a real, available backup, its decryption/restoration access, a suitably isolated restoration target, and an authorized recovery operator. Record a **successful automated restoration check** without exposing live user data in logs or artifacts.
3. **Exclusive deployment authority:** produce a complete privileged-writer inventory covering human CLI/PATs, GitHub Actions, Web/Vercel, other integrations, and any remaining provider-level operators. Obtain provider-authenticated revocation/retirement evidence, or explicitly record each remaining writer as a blocker.
4. **Hosted governance and API scope:** independently verify GitHub Environment protection rules, current token permissions, and read-only effective Data API schema configuration. Do not infer exposed schemas from a `null` database setting.
5. **Evidence provenance:** the existing `recovery()` validator in `scripts/release/fsw-sec-003-release.mjs` checks status booleans, timestamps, environment identity and SHA-256 *format*. `verifyBackup()` checks a corresponding provider backup record. Neither independently authenticates the producer, origin and contents of the **restore** and **writer-retirement** artifacts referenced by the digest strings. Arbitrary hex strings are not evidence.

## Required follow-up — evidence producers, not bypasses

- Prepare a **protected, read-only metadata collector** for each environment. It should collect only allowlisted backup/config/protection metadata using existing scoped access, validate provider identity and permissions, sanitize secrets and user information, and fail closed on missing or incomplete evidence. No migration, role change, backup deletion, or credential widening.
- Design a **separately authorized isolated restore verifier**. It must demonstrate actual recoverability against a disposable, segregated target with explicit authorization and suitable data protection. Do **not** restore a production backup into an uncontrolled environment or perform hosted writes under this documentation task.
- Produce a verifiable **privileged-writer inventory and retirement attestation**. Require provider-authenticated provenance and an explicit treatment for every remaining writer; do not treat an owner statement or hash-only placeholder as proof of retirement.
- Update the release validator only after the evidence format and trusted producer are reviewed. Bind trusted evidence to project, environment, backup ID, authorized operator, source commit, workflow run/attempt, expiration and exact migration SHA; verify actual artifact provenance rather than digest shape alone.
- Add automated negative tests for forged evidence, wrong producer, wrong backup, stale/expired proof, incomplete inventories, missing privileges and cross-environment substitutions. Never turn a missing artifact into a passing path.

**Validation reported in the local handoff:** 60 release tests passed, and all 58 immutable historical migration hashes matched. These are local results, not a new hosted validation claim. The approved FSW-SEC-003 SQL, current workflow, runtime configuration and permissions are unchanged by this documentation update.

**Hosted release acceptance:** NOT RUN. Recovery, exclusive authority, privileged API access and effective environment protections remain **BLOCKED / UNVERIFIED**. Leave `FSW_SEC_003_RELEASE_ENABLED` unset/false. No `workflow_dispatch`, raw SQL shortcut, baseline repair, placeholder receipt or release-specific waiver is authorized by this audit.

When separately approved and evidenced: **FairSwapTest** migration and automated postflight → immutable same-run Test receipt → **FairSwapProd** migration and automated postflight. After production, the owner checks English/Hindi search, category/city/price filters, pagination, error rate and latency. No owner predeployment manual testing is added.

**Rollback:** reviewed forward compensating SQL migration; preserve migration history.

## Protected read-only producer added locally — FSW-SEC-003 continuation

The dedicated `fsw-sec-003-evidence-audit.yml` and
`scripts/release/fsw-sec-003-evidence-audit.mjs` now prepare automated metadata
collection. They have **not** been installed or dispatched on GitHub. Earlier
statements above about no dedicated collector describe the prior inspection.
The existing release workflow, orchestrator, recovery inputs and deployment gates
are unchanged. No enable variable was set; deployment remains disabled by this work.

Requested baseline: `6bd1c5b16963601c936de31b083ff94c32bc5a07`. Local `main` HEAD:
`8f3abe1cb7a5053a7ce2f741ae66d6d969f0c180`. The requested object is unavailable
locally; no fetch/pull or checkout was authorized/performed. Baseline equivalence
is UNVERIFIED. Existing dirty/untracked files were preserved.

### Collection and trust boundaries

- Owner/triggering-owner dispatch on `main`, exact reviewed `approved_sha`, existing
  protected FairSwapTest/FairSwapProd environments, pinned actions and Node 24.15.0.
  `target` selects either environment or both; independent matrix jobs use
  `fail-fast: false`. No Test evidence is copied into Prod. Missing Test credentials
  cannot fall back to Production credentials.
- Only existing `FAIRSWAP_TEST_SUPABASE_ACCESS_TOKEN`,
  `FAIRSWAP_PROD_SUPABASE_ACCESS_TOKEN` and `CHAT_RELEASE_AUDIT_TOKEN` are referenced.
  No credential creation, widening, relocation or new secret names. No database
  passwords, runtime keys, CLI, SQL, backup downloads or restore endpoints.
- GET target identity and require opposite-target 403/404 isolation. Denial or wrong
  identity prevents backup/config reads. Backup and config failures are independent;
  GitHub protection evidence is collected independently using the unchanged
  `inbox-protection.mjs` two-snapshot policy (complete collaborator, ruleset/bypass,
  branch, environment and secret-name metadata). Partial inventories cannot PASS.
  The audit does not change protection policy or claim it inventories external writers.
- Provider backup fields retained: ID, recognized status, creation time, type,
  PITR/WAL flags and physical coverage bounds when returned. A PASS requires a
  completed backup within 24 hours. This does not prove restorability, retention
  policy, encryption/decryption access or Storage-object recovery. No backup ID
  is silently substituted into a deployment recovery receipt.
- Effective provider Data API `db_schema` is recorded; public-only passes, an
  unexpected schema records FAIL, absent/malformed config is UNVERIFIED. This is
  management configuration evidence, not a runtime HTTP/ACL/RLS acceptance test.
- Only sanitized metadata and GitHub protection digests enter canonical receipts.
  Provider payloads, credentials, error bodies and arbitrary error messages are
  never persisted or logged. Redirects, non-JSON/non-200 responses, pagination,
  missing fields, duplicate IDs and unknown shapes fail closed.
- Receipts bind repository, producer workflow, source commit and source bundle,
  environment/project, run ID/attempt and observation time. Local exclusive creation
  prevents overwrites; upload-artifact v4 uses unique target/run/attempt names with
  `overwrite: false`, 90-day retention and checksum sidecars. A credential-free
  step downloads by the producer's immutable artifact ID and checks the digest
  from the producer's trusted job output, binding and 24-hour freshness.
  A checksum supplied by an artifact author alone is **not authentication**.
  Future cross-run consumers must authenticate the successful reviewed producer,
  source, run/attempt and immutable artifact ID using GitHub; never trust copied
  JSON, its self-reported identity or its own checksum. Artifact deletion/expiry
  removes availability; no permanent archival guarantee is claimed.
- Overall metadata PASS requires all four metadata checks to pass. Missing access
  or unexpected responses give UNVERIFIED and a failed collection job while still
  uploading available sanitized evidence. `releaseEligible` remains false and
  recovery/writer inventory/retirement remain UNVERIFIED even on metadata PASS.
  No output is written into `recovery/` or consumed by existing deployment gates.

### Permissions and remaining blockers — separately for both projects

No current provider permissions were exercised. Historical October 18 scope checks
remain the only recorded access evidence; they do not prove these endpoints work.
Both environments need existing access to project metadata, backup listing
(`database:read` / `backups_read`) and PostgREST config (`rest:read` /
`data_api_config_read`). Secret config access is neither required nor requested.
Existing GitHub audit access must expose complete environment/branch protections,
collaborators, ruleset bypass lists and repository/environment secret **names**.
An unavailable permission stays UNVERIFIED; do not mint or widen a token to pass.
Repository-level scoped-token placement remains an authority limitation.

Still requires separate authorization and automated evidence: restore the reviewed
backup on a private disposable recovery target; prove encryption access, ledger,
ACL/RLS, integrity, export and Storage coverage, measured RPO/RTO and retention.
Never restore into Test or Prod. Separately obtain a complete provider-authenticated
privileged-writer inventory (PATs, database logins, CI, services, integrations and
external/manual deployers) and credential-ID-bound legacy retirement records.
Owner attestations, freezes, collaborator/secret lists and inactivity are insufficient.
No old token values or runtime key revocations are needed. Existing release evidence
validation still requires separately authorized producer-authentication hardening;
this collector does not repair or bypass that gate.

Hosted Test: NOT RUN / UNVERIFIED. Hosted Prod: NOT RUN / UNVERIFIED.
Synthetic coverage includes each environment independently, target/scope failures,
missing permissions, forgery, expiry, malformed responses and incomplete inventories.
Local reproduction: `node --test tests/fsw-sec-003/evidence-audit.test.mjs`.

After separate release authorization: Test verification/migration → automated
postflight → Prod verification/migration → automated postflight. Rollback for this
change: revert only the audit-source additions. Future SQL rollback remains a
forward compensating migration preserving history. No manual/exploratory tests.

Provider contracts reviewed: [backup metadata](https://supabase.com/docs/reference/api/v1-list-all-backups),
[Data API configuration](https://supabase.com/docs/reference/api/v1-get-postgrest-service-config).
The changelog markdown endpoint could not be read through the documentation fetcher;
no changelog compatibility claim is made.

Validation for this continuation (Node 24.21.0): **PASS 113/113** Node tests
(53 new audit tests plus 60 existing release tests), zero failures/skips.
`node scripts/ci/verify-baseline.mjs`: PASS, 58 canonical migration hashes.
`node --check scripts/release/fsw-sec-003-evidence-audit.mjs`, Ruby YAML parsing
and `git diff --check`: PASS. Python/Node YAML parsers were unavailable; Ruby's
bundled YAML parser supplied the syntax check. CI's Node 24.15.0 and hosted
protection enforcement remain NOT RUN. No dependencies were installed.

Exact files changed in this continuation only:

- `.github/workflows/fsw-sec-003-evidence-audit.yml` (new)
- `scripts/release/fsw-sec-003-evidence-audit.mjs` (new)
- `tests/fsw-sec-003/evidence-audit.test.mjs` (new)
- `releases/candidates/fsw-sec-003/EVIDENCE_GAPS.md` (append)
- `releases/candidates/fsw-sec-003/README.md` (append)
