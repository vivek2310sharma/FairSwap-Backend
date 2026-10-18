# Backend-only deployment ownership cutover — preparation checkpoint

**Status: PREPARED / NOT YET AUTHORITY-TRANSFERRED (18 October 2026).** This document explicitly does **not** claim that Web deployment credentials have been revoked or that Backend has been granted exclusive deploy rights.

## Current verified evidence

- Shared Backend source and 58 immutable historical SQL files are present in `FairSwap-Backend`.
- FairSwapProd `kriuhwppxgxsyyrbjsau` has exactly **52 pinned Production migration versions** from the approved hidden-category release; recorded in [Production receipt](../../releases/production/category-foundation-v1/production-deployment-20261018.json).
- Web staging [draft PR #159](https://github.com/vivek2310sharma/FairSwap-Web/pull/159) prepares removing 58 duplicated migrations and 10 pgTAP SQL files, replacing them with an ephemeral GitHub App **Contents-read** checkout of an immutable Backend commit. This is not merged or tested until the App is provisioned.
- Web currently retains the original 58 migration files, Edge workers, Auth templates and moderation modules on its protected production path. Production Web runtime Supabase connection secrets are needed for normal login, listing submission, media and moderation integrations.
- Web tracked GitHub Actions CI is local/disposable Supabase testing; no hosted schema/function deployment step was found there. **Absence of a code deployment step is not proof of absent manual or personal token deployment authority.**

## Only supported owner split

| Resource | Source and deploy owner |
| --- | --- |
| Hosted Supabase schema / policies / RLS / RPCs / triggers / Storage / Auth templates / Edge Functions | **Backend-only, after verified transfer** |
| Vercel, Next.js pages, Server Actions, app-owned HTTP APIs, Auth session integration, media routes | **Web** |
| Supabase keys used at runtime by Next.js server/browser | **Keep in Web at their necessary privilege**; not equivalent to release credentials |
| GitHub Actions read-only private Backend source access for Web CI | **Read-only GitHub App**; never use a backend deployment token |
| Production activation of Cars, Two-Wheelers, Property | Unchanged, OFF |

## Mandatory safe cutover (no overlap)

1. Inventory **metadata only** for Web repository Actions secrets/environments, Web operator CLI tokens, PATs, local CLI login, externally managed deployment jobs and Vercel environment variables. Do not print or share secret values. Identify **deploy credentials** separately from necessary **Web runtime** credentials.
2. Configure and test an owner-approved GitHub App installation on private Backend with **Contents: read** only. Configure Web `FAIRSWAP_BACKEND_CI_APP_ID` as an Actions variable and `FAIRSWAP_BACKEND_CI_APP_PRIVATE_KEY` as an Actions secret. Confirm PR #159 Web staging CI passes using the pinned Backend commit and all original tests, and Vercel Preview remains healthy. Only then merge the Web source cleanup and review any remaining duplicated runtime modules.
3. Freeze hosted backend releases from Web. Revoke **Web-only backend deploy** PATs/CI secrets and old deploy integrations, including any manual Web operator release token no longer authorized. Verify that the Web-owned deploy path cannot update Supabase. **Do not revoke the required Web application runtime Supabase keys.**
4. After Web deploy revocation is confirmed, grant a distinct Backend-owned, least-privileged operator identity or protected GitHub Environment for releases. Require human approval, reviewed migration hashes, linked project identity, verified dry-run and a Production ledger comparison.
5. Use an **isolated 52-version Production workspace**, never raw Backend `supabase/migrations/` (which still holds Test-only source versions). `node scripts/release/verify-production-52-baseline.mjs /absolute/isolation/workspace` checks that workspace **without executing SQL or network calls**. Future migrations require separately reviewed forward files and a new receipt/guard.
6. Verify actual permission boundaries: Web can still sign in, upload media, submit Goods listings through `seller_submit_listing` and run read-only CI; it cannot perform hosted database/Edge deployments. Backend-only operator can deploy using the approved runbook. Record evidence and update ownership status **only after** these checks.

No hosted Supabase writes, GitHub environment/secret changes, Vercel deployments, PR merges, or Github Actions are executed by preparing this PR. Never infer the transfer happened just from these instructions. The separate security/restore/activation items are outside this ownership task.
