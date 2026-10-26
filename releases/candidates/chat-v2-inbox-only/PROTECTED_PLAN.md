# Protected release implementation plan

1. Preserve PR60's exact foundation, existing tests, historical bytes and unrelated
   local changes. Capture observed local HEAD separately from PR60 head abd14cc5.
2. Add a separate PG17 native fixture/CI workflow without editing legacy gate counts
   or dependency pins. Exercise actual roles, RLS, pagination and migration contracts.
3. Replace the hosted execution path's custom ledger insertion with supported
   Supabase migration up in an isolated one-file workspace, guarded by full ledger,
   identity and installed-object checks. Keep old renderer tests as legacy/offline
   evidence; disable its direct-apply CLI export to prevent operational ambiguity.
4. Prepare manual/default-off main-only workflow: immutable reviewed source bundle,
   native verification, protected FairSwapTest job and receipt, then independently
   approved FairSwapProd job consuming the same-run verified Test receipt.
5. Validate administration controls and environment-only credential metadata before
   database use; fail closed if APIs/protection/authority evidence are unavailable.
   Keep credentials only in subprocess environment, never artifacts or diagnostics.
6. Add postflight/receipts, interruption recovery and non-destructive rollback;
   document verified public visibility and unverified administration/authority state.
7. Run local automated checks only and package scoped diff, hashes and blockers.

No hosted execution, workflow dispatch, administration mutation, Git commit or
feature activation is authorized in this session. All five DB flags remain off;
the Web flag is untouched and requires protected off-state evidence for release.
