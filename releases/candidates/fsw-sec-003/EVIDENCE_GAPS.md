# FSW-SEC-003 — Recovery and deployment-authority evidence gaps

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
