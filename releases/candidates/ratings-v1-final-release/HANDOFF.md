# Ratings V1 final release handoff

Starting local SHA: 213b57c84e2b3767e3ab3499846dd280bf3315c3 (unsynchronized main).
Reviewed PR #59: 5d3378a9d35c734193bbfcf421864d3b91865947. All six raw Ratings source
files verified to that exact head. No migration/historical SQL source changed.

Both environment release records: backup/restore WAIVED_BY_OWNER, solely for Ratings V1.
No backup verified, no restore passed; irreversible loss, downtime and limited recovery
accepted. No guaranteed point-in-time recovery. All non-backup checks remain mandatory.

HDR-03: merged PR #49 + operator receipt + reviewed SQL reconstruct installed metadata;
narrow Production NULL exception now pins exact row and complete owned contract.
Both ledgers freshly match 87/71; all 37 protected function fingerprints per environment
match. Full preflight BLOCKED at the existing identity guard for both projects.

Local PG17: 18 passing check groups per environment, including exact historical
exception negatives and existing onboarding/privacy/mobile assumptions. See checks.json
and logs for final evidence/limits. New mandatory CI code is local, NOT RUN on GitHub.
Prior reviewed-head Backend CI 40391229761 succeeded; it predates the new gate.

ChatGPT: apply scoped.diff to the reviewed PR, preserving its existing CI. The workflow
patch is against ci-reviewed-head.before.yml and adds only the new mandatory gate;
ci-reviewed-head.after.yml shows the result. Do not replace it with the full local
workflow, which contains unrelated Chat work. New candidate files use repository paths.
Local workflow additions preserve that local work; separate local-workflow.diff records
only this task's delta from its saved original. No branch/commit/push/PR/deploy performed.

Remaining blockers: identity guards; exclusive Backend operator/project permissions and
legacy writer revocation; full other-history source provenance; new remote CI and full
chain/load/consumer evidence. Neither the backup waiver nor HDR receipt resolves them.

Sequence: Test six migrations → inactive schedules/postflight → Web/Admin staging OFF →
independent Prod preflight → Prod six → inactive schedules/postflight → focused Web/Admin
production OFF → separate activation. No manual testing/additional staging acceptance.

Rollback: disable Ratings flags/schedules, revert affected Web/Admin deployments,
preserve records/privacy erasure, reviewed forward fixes. No guaranteed PITR.

Run verify.mjs for integrity; --ready intentionally exits 2 on known non-backup gates.
run-pg17.ps1 and run-pg17.sh use disposable loopback PG17 only; CI uses the existing
checksum-pinned source build. No hosted DB URL/credentials are accepted by fixture runners.
