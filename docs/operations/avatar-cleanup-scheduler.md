# Avatar cleanup scheduler (FairSwap Web, staging + production)

**Workflow:** [`.github/workflows/avatar-cleanup-15m.yml`](../../.github/workflows/avatar-cleanup-15m.yml) in **FairSwap-Backend**. GitHub Actions runs on the repository default branch, `main`, at minute 7, 22, 37 and 52 of every hour (UTC). GitHub may delay or drop scheduled runs during high load; this job is a retry safety net, not a strict deletion SLA.

**Costs:** FairSwap-Backend is public, so standard GitHub-hosted runner minutes are free, subject to GitHub's Actions usage limits. Supabase Storage and Vercel invocation quotas still apply.

## No-op until enabled

Both jobs are intentionally gated by repository variables. Until enabled, no GitHub runner is started and no request is sent:

- `AVATAR_CLEANUP_STAGING_ENABLED=true`
- `AVATAR_CLEANUP_PRODUCTION_ENABLED=true`

Set each variable **only after** that environment has received the eight profile migrations, the `avatars` bucket, the Web cleanup endpoint, and matching credentials.

## Credential setup (never store values in git, PRs or chat)

**GitHub repository:** `vivek2310sharma/FairSwap-Backend` → Settings → Secrets and variables → Actions.

Create these *repository secrets*:

| GitHub Actions secret | Match / source |
| --- | --- |
| `AVATAR_CLEANUP_STAGING_SECRET` | Equal to Vercel **Preview / staging** server-only `AVATAR_CLEANUP_SECRET` (use a unique cryptographically random 32+ byte token) |
| `AVATAR_CLEANUP_PRODUCTION_SECRET` | Equal to Vercel **Production** server-only `AVATAR_CLEANUP_SECRET` (a different token) |
| `VERCEL_STAGING_BYPASS_SECRET` | Vercel project's **Deployment Protection → Protection Bypass for Automation** secret. The staging branch URL has Vercel Authentication enabled. Never use this as the cleanup bearer token. |

**Vercel team/project:** `fairswap / fairswap-web`.

- Preview/branch `staging`: server-only `AVATAR_CLEANUP_SECRET` matching the GitHub staging secret.
- Production: server-only `AVATAR_CLEANUP_SECRET` matching the GitHub production secret.
- Ensure the normal Supabase service-role key exists separately in the respective deployments; it is never passed to GitHub Actions.
- The Web cleanup API expects `Authorization: Bearer <AVATAR_CLEANUP_SECRET>`; staging additionally requires `x-vercel-protection-bypass: <VERCEL_STAGING_BYPASS_SECRET>` to pass Vercel preview protection.
- `CRON_SECRET` is **not required** for this GitHub scheduler. The old 15-minute Vercel Cron entry must be removed from the Web PR's `vercel.json` before deployment, because FairSwap is on Vercel Hobby.

## Fixed endpoints

- Staging: `https://fairswap-web-git-staging-fairswap.vercel.app/api/internal/avatar-cleanup` (Vercel auto-managed staging branch alias, currently protected).
- Production: `https://fairswap.in/api/internal/avatar-cleanup`.

The workflow uses HTTPS POST without redirects and does not disclose tokens or object paths. It fails when HTTP is not 200, when `ok` is false, or if the response reports failed deletions; output is only aggregate counts. Each run is bounded and uses Backend's leased, idempotent queue RPCs. No user-visible functionality is scheduled directly.

## Release order

1. GitHub workflow can be merged to **Backend main** now, with both enabled flags unset/false (safe no-op).
2. Apply the profile migrations and `avatars` bucket on **FairSwapTest**; regenerate Web database types; deploy **Web staging**.
3. Set staging Vercel secret, GitHub staging secret, Vercel automation bypass secret, and enable only `AVATAR_CLEANUP_STAGING_ENABLED=true`. Confirm the scheduled job is successful using GitHub Actions and read-only queue monitoring (no exploratory/manual test required).
4. Apply migrations and the bucket on **FairSwapProd**; deploy **Web production**; set production matching secrets; enable `AVATAR_CLEANUP_PRODUCTION_ENABLED=true`.
5. Monitor GitHub Actions status and Backend queue/dead-letter counts. If cron is interrupted, the next invocation retries due to queue leases.

**Rollback:** Set the relevant enabled variable to `false` immediately; revert the Web release or restore the preceding Vercel deployment, and preserve additive database objects pending a reviewed forward repair.

**Security:** Do not put secrets into source, deployment URLs, logs, GitHub Action parameters, or GitHub Variables (use **Secrets**). Restrict workflow edits to trusted maintainers.
