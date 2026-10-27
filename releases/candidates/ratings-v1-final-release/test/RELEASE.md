# test Ratings V1 release instructions

Project wpppxlnbzqynvhpeuavd; exact baseline 87; planned result 93. NOT EXECUTED.
Backup/restore verification: **WAIVED_BY_OWNER** solely for Ratings V1. No backup is
verified to exist; no isolated restore passed. Owner accepts irreversible data loss,
downtime and limited recovery; no guaranteed point-in-time recovery. Other gates remain.

1. Resolve this project's identity-guard rejection, exclusive Backend operator and
   project-specific authority/no overlapping legacy writer proof. Complete the exact
   historical-source mapping and isolated workspace. Record release window/reviewer,
   secure execution binding and monitoring thresholds. Do not deploy this six-file payload
   folder or the raw historical directory. Require the new mandatory remote PG17 gate
   and every existing CI gate to pass.
2. Refresh the complete version/name/statement-fingerprint ledger and protected function
   definitions/ACLs. Run this environment's preflight.sql read-only through the verified
   protected connection, psql -X -v ON_ERROR_STOP=1 --file. Current full preflight is
   BLOCKED_RATINGS_ENVIRONMENT_MISMATCH; no bypass is authorized.
3. Verify all six file hashes against manifest.json and reviewed PR head. Review the
   pinned-CLI dry-run from the complete isolated workspace showing exactly those six
   files in order, then obtain explicit protected operator application authorization.
4. Apply the six Backend files sequentially. Record each actual committed version/name,
   source hash, operator receipt, time and statement-array fingerprint. A later failure
   does not permit replay of an earlier committed migration. No Test-only SQL is promoted.
5. Provision only this environment's inactive.sql after all six, then its automated
   postflight.sql: exact baseline+six delta, protected contracts, flags all OFF, two
   inactive jobs with correct command/cadence, unrelated jobs unchanged. Record outputs
   without credentials/private data in a new receipt based on receipt.template.json.
6. Release compatible focused Web staging and Admin staging, flags OFF. Continue to independent Production preflight under separate identity/permission/source evidence.
7. Separate controlled activation only after compatible consumer, privacy, security,
   aggregate/idempotency/backlog/load and automated service gates. No manual/exploratory
   testing or additional owner staging acceptance step. No activation SQL in package.

Test has no historical NULL exception. Preserve all 87 Test-specific rows; none may fill missing Production source history.

Rollback: matching rollback-disable.sql for Ratings flags/jobs; revert affected Web/Admin
deployments; preserve records/privacy erasure; reviewed forward fixes. No guaranteed PITR.
See recovery.md and the master RELEASE.md for partial-apply and production owner checks.
