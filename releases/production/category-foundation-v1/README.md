# Phase 1 — Production-hidden category schema (REVIEW ONLY)

**TARGET:** FairSwapProd `kriuhwppxgxsyyrbjsau`, PostgreSQL 17.6, **45** currently applied migrations. **SOURCE:** Backend `main` canonical 58-file checksum-pinned migrations. **STATE:** `PREPARATION_ONLY_NOT_APPROVED_FOR_EXECUTION`.

This is a concrete release *candidate* for adding the **draft-contract infrastructure** of Cars, Two-Wheelers and Property without enabling their categories or publication. It is **not** the new category launch. No historical migration changes, Test-only code, credentials, external outbound jobs, or live DB writes are included in this PR.

## Exact candidate phase-one source files (7)

The seven paths, in order, are in [manifest.json](manifest.json). They import the source contracts and validated catalogue snapshots, install draft-only guard functions, and leave all experimental categories/new assignments **disabled**. Files are hash-pinned to the existing 58-file extraction manifest. This phase excludes all Test-only activation, the experimental finalizer, the moderation trigger repair already unneeded on Production, the test submission policy and the Post-Ad compatibility overlay.

**Do not** use `supabase db push` or apply all 58 original Backend migrations to Production. Production applied 45; the Backend source contains 13 additional migrations, and Test has 3 further migration records (61 total). Never cherry-pick `enable_test_*` migrations.

## Read-only release-preparation commands

```bash
node scripts/ci/verify-production-category-release.mjs
node --test scripts/ci/verify-production-category-release.test.mjs
```

CI runs these without Supabase credentials or a database connection, verifies all seven SQL SHA-256 hashes, denies unexpected source/activation changes and verifies the **58 original migration files are unchanged**. The static script is not an integration test and does not prove the schema migration succeeds against Production's 45-version state.

## Staged release gates (all deliberately OPEN)

1. **Recovery:** Verify Production Supabase backup availability and complete a recoverable restore/PITR rehearsal using an operator-approved isolated environment. The connected Supabase tools do not expose backup confirmation here. Creating a new hosted Supabase branch can cost money and needs separate cost approval.
2. **True 45-migration rehearsal:** On a disposable Production-baseline replica, run `preflight.readonly.sql`, then apply **exactly seven source files in manifest order** as individually reviewed forward-only migration entries; assert no Test-only step is applied. Run `postflight.readonly.sql` and all Goods moderation/RLS/Post-Ad regression checks. Do not test against a 58-migration already-complete fixture and claim Production compatibility.
3. **Security:** Resolve or explicitly review the existing Supabase advisor WARN items, especially publicly executable SECURITY DEFINER functions. Check service-role-only moderation RPCs and seller RLS after applying each migration.
4. **Source deploy ownership:** Keep FairSwap-Backend as canonical source, with one controlled deployment owner; do not leave simultaneously active Web and Backend schema deployers. [Web handoff issue #157](https://github.com/vivek2310sharma/FairSwap-Web/issues/157).
5. **Actual Production release:** Obtain reviewed SQL hashes, backups, reviewer approval, rollback/forward-fix plan and a release window. First apply migration to Production, validate `postflight.readonly.sql` and Goods tests, and **only then** deploy a separate Web production build with category flags off. Roll back/disable via approved forward-fix on failure.
6. **Separate launch:** Later approve Cars, Two-Wheelers and Property submissions/publication only after fresh browser acceptance tests for each category. Never remove publication guards simply because this hidden-schema phase passed.

**Production status:** No changes in this release-preparation PR. See [issue #5](https://github.com/vivek2310sharma/FairSwap-Backend/issues/5) for follow-up.
