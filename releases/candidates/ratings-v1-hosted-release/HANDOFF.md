# Ratings V1 hosted release readiness handoff

Local-only package. Exact starting SHA `213b57c84e2b3767e3ab3499846dd280bf3315c3`.
No synchronization, GitHub mutations, hosted writes, deployment or activation.

- Added only `releases/candidates/ratings-v1-hosted-release/`; exact inventory in
  `changed-files.json`, all additions shown in `scoped.diff`, byte hashes in `SHA256SUMS`.
- Consolidated six original byte-pinned Ratings files with independent Test/Production
  payloads, manifests, read-only pre/postflight, inactive provisioning, receipt and recovery.
- Read-only hosted ledger reconciliation: Test 87, Production 71; Production
  `20261023160752` checksum evidence unavailable. Full source provenance remains BLOCKED.
- 24 new disposable PG17 assertions (12 per environment); 46 existing Ratings PG17
  checks; all 58 historical Git blob hashes/working EOL representations verified.
  Read-only GitHub Backend CI run `40340690551` succeeded at PR head `2c34f113…`.
- Hosted release blocked on independent writer revocation/exclusive Backend authority,
  current backup plus demonstrated restore for each environment, exact history-source
  workspaces, source-to-PR verification, full-chain/load and consumer release evidence.
- Unrelated concurrent changes are listed in `preservation.json`; this task did not
  edit, revert or package them. Existing CI/config/SQL sources remain untouched by task.

One-line rollback: disable only Ratings flags/jobs with the matching environment
script, revert affected Web/Admin builds, preserve data/privacy erasure, forward-fix.

Run `node releases/candidates/ratings-v1-hosted-release/verify.mjs` from the reviewed
Backend checkout to verify payload hashes and scoped integrity. Add `--preservation`
for a strict unrelated snapshot check (concurrent edits cause exit 1); `--ready`
deliberately exits 2 while authority/history/backup blockers remain. The ZIP is a
readiness artifact; it is not a standalone complete Backend/CLI workspace.

Reproduce the new automated regression using `run-pg17.ps1 -PgBin <absolute PG17 bin>
-PsqlBin <absolute psql17 bin>` from the reviewed checkout. It creates unique
loopback-only clusters, strips inherited credential variables from psql, stops each
cluster and deletes only its validated temporary data directory. No remote DB target
is accepted. Original Ratings test support and source dependencies remain in the repo.
