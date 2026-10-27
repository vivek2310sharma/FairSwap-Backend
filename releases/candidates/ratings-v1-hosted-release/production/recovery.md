# production recovery

Target kriuhwppxgxsyyrbjsau only. Backup/restore proof is BLOCKED until this environment has a current pre-apply backup ID/time, retention/PITR coverage, encrypted access reference, successful isolated restore receipt, integrity/ACL/export verification, measured RPO/RTO and named recovery operator. Never include dumps, user data or credentials. Production cannot reuse Test proof. Revalidate at release time.

On any failure stop this environment. Each immutable migration commits separately; compare exact ledger and catalog before deciding a reviewed forward fix or missing suffix. Never replay a committed file or repair/mark history to hide failure. A lost apply acknowledgement requires ledger+catalog reconciliation, not retry by assumption. A partial or unexpected Ratings installation fails fresh preflight. Keep consumers/flags OFF and schedules absent/inactive.

One-line rollback: run this environment's authorized rollback-disable.sql, revert affected Web/Admin consumer builds, preserve additive data and privacy erasure, then use a reviewed forward fix.

If failure precedes ratings_settings creation, leave flags/jobs absent and skip the kill-switch SQL; reconcile first. No DROP, historical undo, old-exporter replacement or automatic backup restore. Restore only under separate incident approval after accounting for post-backup writes and replay/reconciliation. Record decision, elapsed recovery and automated service availability in this environment's receipt.
