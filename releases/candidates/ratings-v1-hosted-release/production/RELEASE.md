# FairSwapProd release instructions

Project `kriuhwppxgxsyyrbjsau`; baseline 71, latest `20261025201712`; planned result 77.
Status BLOCKED / NOT EXECUTED. Never use Test history, permissions, approval or backup.

1. After the sequence through Web/Admin staging in `../RELEASE.md`, independently
   close Production history-source, exclusive authority and current backup/restore
   blockers. In particular `20261023160752` has no stored statements/hash: obtain
   original authoritative deployment evidence and a reviewed reconciliation. This
   package's Production preflight remains deliberately blocked on that missing evidence.
2. Record Production release window, principal, independent human reviewer, monitoring
   thresholds/window, restore proof and recovery owner in a new Production receipt.
   Reverify PR revision and all existing CI plus readiness evidence; verify the six
   hashes. The older 52-version verifier proves only its historical prefix.
3. Independently verify protected connection/project identity. Run this folder's
   `preflight.sql` read-only with `psql -X -v ON_ERROR_STOP=1 --file` and the absolute
   script path using approved credential injection; never log tokens/connection values.
   Any drift or missing proof stops Production. Regenerate/review the package after
   evidence changes rather than deleting a guard or repairing ledger history.
4. Build an independently reviewed complete 71-version isolated workspace from
   authoritative original bytes, then add exactly these six pending migrations.
   This folder's six-file payload is not a complete CLI workspace. A pinned-CLI
   dry-run must show only those six. Obtain explicit protected operator approval
   and apply sequentially in `manifest.json` order, with individual receipts.
5. Run only Production `inactive.sql`, then `postflight.sql`. Record exact baseline
   plus six delta, flags OFF, both schedules inactive, correct commands/cadences,
   unchanged protected staff/export/mobile contracts and no unrelated job changes.
6. Deploy focused Web production and Admin production, flags OFF; record build IDs
   and automated availability/error-trend checks. Production owner records postflight,
   privacy/permission/category safety evidence and rollback decision as in the master
   release instructions. No owner manual testing is requested before deployment.
7. Feature activation is a separate authorized release after all automated safety,
   performance, consumer and recovery gates. Do not enable flags/jobs for a smoke test.

Rollback: authorized `production/rollback-disable.sql`, revert affected production
consumer builds, preserve additive data/erasure and use a reviewed forward fix.
Use `recovery.md` for partial application and independent Production recovery proof.
