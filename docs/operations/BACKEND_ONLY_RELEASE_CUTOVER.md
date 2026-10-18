# Backend-only deployment ownership cutover — preparation checkpoint

**Status: PREPARED / NOT YET AUTHORITY-TRANSFERRED (18 October 2026).** This document explicitly does **not** claim that Web deployment credentials have been revoked or that Backend has been granted exclusive deploy rights.

## Current verified evidence

- Shared Backend source and 58 immutable historical SQL files are present in `FairSwap-Backend`.
- FairSwapProd `kriuhwppxgxsyyrbjsau` has exactly **52 pinned Production migration versions** from the approved hidden-category release; recorded in [Production receipt](../../releases/production/category-foundation-v1/production-deployment-20261018.json).
- Web staging [PR #159](https://github.com/vivek2310sharma/FairSwap-Web/pull/159) **merged**, and the focused Web Production [PR #160](https://github.com/vivek2310sharma/FairSwap-Web/pull/160) **merged**. Both Web branches removed 58 duplicated migrations and 10 pgTAP SQL files. The ephemeral GitHub App **Contents-read** checkout is operational with pinned Backend commit `2f26f839c3fa0ae690cf5c3795a983d62e1b6c47`. Main-based CI [39115868525](https://github.com/vivek2310sharma/FairSwap-Web/actions/runs/39115868525) and Help Centre CI [39115868534](https://github.com/vivek2310sharma/FairSwap-Web/actions/runs/39115868534) passed, with a READY preview.
- Web `main` and `staging` now each have **zero tracked migration SQL files and zero tracked pgTAP SQL files**. They retain runtime-/test-dependent Edge workers, Auth templates, local Supabase configuration and moderation modules where deletion was not proven safe. Production Web runtime Supabase connection keys are needed for normal login, listing submission, media and moderation integrations.
- Web tracked GitHub Actions CI is local/disposable Supabase testing; no hosted schema/function deployment step was found there. **Absence of a code deployment step is not proof of absent manual or personal token deployment authority.**

## Only supported owner split

| Resource | Source and deploy owner |
| --- | --- |
| Hosted Supabase schema / policies / RLS / RPCs / triggers / Storage / Auth templates / Edge Functions | **Backend-only, after verified transfer** |
| Vercel, Next.js pages, Server Actions, app-owned HTTP APIs, Auth session integration, media routes | **Web** |
| Supabase keys used at runtime by Next.js server/browser | **Keep in Web at their necessary privilege**; not equivalent to release credentials |
| GitHub Actions read-only private Backend source access for Web CI | **Read-only GitHub App**; never use a backend deployment token |
| Production activation of Cars, Two-Wheelers, Property | Unchanged, OFF |

## Access credential setup — read-only scope verified

On 18 October 2026 the owner created two Supabase **project-scoped** PATs (set to never expire) and saved their values in **FairSwap-Backend repository Actions secrets**. Each secret was exercised only by its matching **manually triggered, read-only GitHub Actions job**. Both jobs succeeded:

- **Test:** [`FAIRSWAP_TEST_SUPABASE_ACCESS_TOKEN` check](https://github.com/vivek2310sharma/FairSwap-Backend/actions/runs/39126378994), `verify-test` passed; Test responded HTTP 200 and Production rejected the token (HTTP 403/404).
- **Production:** [`FAIRSWAP_PROD_SUPABASE_ACCESS_TOKEN` check](https://github.com/vivek2310sharma/FairSwap-Backend/actions/runs/39126417831), `verify-production` passed; Production responded HTTP 200 and Test rejected the token (HTTP 403/404).

These runs establish presence and correct **project read-access isolation**, not a successful migration deploy, independent approval enforcement, or revocation of old identities. Token values were not displayed. See the [token scope guide](BACKEND_SCOPED_TOKEN_CHECK.md).

**Authority transfer remains pending:** Web/manual CLI deploy identities have not been independently revoked, and no hosted database/Edge deployment workflow is installed. `main` raw 58-file migrations are not safe for either Test (live 61) or Production (live 52). Keep Production remote SQL changes disabled.

## Mandatory safe cutover (no overlap)

1. Inventory **metadata only** for Web repository Actions secrets/environments, Web operator CLI tokens, PATs, local CLI login, externally managed deployment jobs and Vercel environment variables. Do not print or share secret values. Identify **deploy credentials** separately from necessary **Web runtime** credentials.
2. **DONE (18 Oct 2026):** An owner-approved GitHub App installation provides private Backend **Contents: read** only. Web uses `FAIRSWAP_BACKEND_CI_APP_ID` (Actions variable) and `FAIRSWAP_BACKEND_CI_APP_PRIVATE_KEY` (Actions secret). Both Web staging and Production-focused main PRs passed their scoped CI and Preview checks, were merged without S1/Test-only promotion, and removed all 68 redundant tracked SQL files. Review any remaining duplicated runtime modules individually.
3. Freeze hosted backend releases from Web. Revoke **Web-only backend deploy** PATs/CI secrets and old deploy integrations, including any manual Web operator release token no longer authorized. Verify that the Web-owned deploy path cannot update Supabase. **Do not revoke the required Web application runtime Supabase keys.**
4. After Web deploy revocation is confirmed, grant a distinct Backend-owned, least-privileged operator identity or protected GitHub Environment for releases. Require human approval, reviewed migration hashes, linked project identity, verified dry-run and a Production ledger comparison.
5. Use an **isolated 52-version Production workspace**, never raw Backend `supabase/migrations/` (which still holds Test-only source versions). `node scripts/release/verify-production-52-baseline.mjs /absolute/isolation/workspace` checks that workspace **without executing SQL or network calls**. Future migrations require separately reviewed forward files and a new receipt/guard.
6. Verify actual permission boundaries: Web can still sign in, upload media, submit Goods listings through `seller_submit_listing` and run read-only CI; it cannot perform hosted database/Edge deployments. Backend-only operator can deploy using the approved runbook. Record evidence and update ownership status **only after** these checks.

This Backend pull request makes no hosted Supabase writes, no GitHub environment/secret changes, and no application deployments. The separately approved Web PRs above were actually merged and tested. **Do not infer deployment-credential transfer from the Web source handoff or this Backend documentation**; gate 1 and gates 3–6 remain unverified until credential inventories, revocations and Backend release authority are checked. The separate security/restore/activation items remain out of scope. The separate security/restore/activation items are outside this ownership task.
