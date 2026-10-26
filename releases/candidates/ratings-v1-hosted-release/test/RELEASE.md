# FairSwapTest release instructions

Project `wpppxlnbzqynvhpeuavd`; baseline 87, latest `20261025195824`; planned result 93.
Status BLOCKED / NOT EXECUTED. Use only this folder's manifest, SQL and receipt.

1. Close Test-specific history-source, exclusive authority and current backup/restore
   blockers in `../BLOCKERS.md`. Record approved release window, reviewer, principal,
   monitoring thresholds and recovery owner in `receipt.template.json` (a new receipt,
   not a claim that this template was executed). Verify six source hashes against
   `../migration-order.json` and `../SHA256SUMS`.
2. Independently bind the protected operator connection to this project. Run
   `preflight.sql` read-only with `psql -X -v ON_ERROR_STOP=1 --file` and the absolute
   script path through the approved credential injection. Capture no connection
   credentials. Refresh evidence on ledger/function drift; never weaken the guards.
3. Prepare the complete isolated Test history from reviewed authoritative bytes;
   do not treat this folder's six-file payload as a complete CLI workspace. Review
   pinned-CLI dry-run output showing exactly six pending Ratings files in manifest
   order. Application remains prohibited until explicit protected operator approval.
4. Under that future authorization apply exactly those six original files. Capture
   each committed version/name, file SHA-256, statement-array fingerprint, timestamp
   and apply receipt. Do not replay a successful migration after a later failure.
5. Run this folder's `inactive.sql`, then `postflight.sql`; verify both schedules
   inactive, all four flags OFF, preserved protected functions and full baseline plus
   exact six-version delta. Retain read-only outputs in the Test receipt.
6. Deploy separately reviewed Web staging and Admin staging with consumer flags OFF;
   capture CI/build/deployment automated results. Target/flag mapping remains unresolved.
7. Continue to independent Production preflight under its own evidence; no manual
   testing or additional owner staging approval is imposed. Activation is separate.

Rollback: authorized `test/rollback-disable.sql`, revert affected staging consumer
builds, preserve additive Ratings data/erasure and use a reviewed forward fix.
Use `recovery.md` for partial-apply handling and current Test restore requirements.
