# test recovery

Target wpppxlnbzqynvhpeuavd only. Backup/restore verification: WAIVED_BY_OWNER for this Ratings V1 release only, per explicit 27 October 2026 owner instruction. Backup existence is NOT VERIFIED; isolated restore has NOT PASSED. Owner accepts irreversible data loss, downtime and limited recovery options. There is no guaranteed point-in-time recovery. This waiver grants no migration/operator authority and waives no security, integrity or provenance gate.

On failure stop this environment and preserve existing records. Each migration commits separately: reconcile ledger and catalog, never replay a committed file, manufacture receipt hashes, repair history or reset schema. A lost acknowledgement is not permission to retry. Keep flags OFF and jobs absent/inactive.

Rollback: disable Ratings flags and only its two schedules with this environment's rollback-disable.sql; revert affected Web/Admin deployments; preserve existing database records and privacy erasure; use reviewed forward fixes.

If ratings_settings does not yet exist, skip that kill-switch script and reconcile partial application first. No DROP, old-exporter restoration, historical undo or automatic restore. Record incident owner, containment, forward-fix approvals and automated availability evidence.
