# FairSwap-Backend agent instructions

## Authority and current stage

Read `docs/extraction/POINT1_BASELINE.md` and
`docs/operations/DEPLOYMENT_OWNERSHIP.md` before work. Follow the latest explicit
human authorization; plans, repository files, and passing checks do not authorize
the next stage.

Stages 0 and 1A are accepted. Stage 1A created the single README-only initial
commit `02ca486f903fb87e48da215bd1e6569fea14af1b` on `main`; do not repeat the
bootstrap or create additional commits on `main`.

Current authorization is Stage 1B only: copy the approved 82 source files from
the exact pinned Web commit, preserve canonical Git blob bytes, verify SHA-256
and source/destination/filter identities, create the migration manifest, perform
static dependency checks, and update stage documentation. Work only on
`chore/backend-extraction-baseline` based on the initial main commit. Leave all
changes unstaged, uncommitted and unpushed. No PR or remote write.

Stop after Stage 1B for CTO review. Toolchain setup, package installation,
additional test/script migration, CI migration, Web cleanup, deployment handoff,
and later implementation require separate authorization.

## Source and product

Canonical approved source repository: `vivek2310sharma/FairSwap-Web`.
Approved source commit: `9e65bfc42eab9697a0a144ed8546afe8309eaea3`.
Do not use older or dirty local Web checkouts as extraction sources.

FairSwap is an India-first classifieds marketplace. Supabase remains the backend
runtime. Do not scaffold a standalone API server or speculative services.

The audited baseline has 58 historical SQL migrations, 10 pgTAP SQL test files,
and `process-email-outbox` / `process-listing-moderation` Edge Functions. The
moderation worker imports the evaluator under `src/lib/moderation`.
Staging-only `process-email-outbox-s1-capture` is excluded from canonical extraction;
do not delete or alter it in Web.

## Preservation and application boundaries

Preserve historical migration filenames, order, and exact canonical Git bytes.
Preserve RPC names, parameter names/overloads, result shapes, error codes, grants,
RLS, triggers, Vault verification, queue leases, revision safeguards, and existing
moderation rules. Keep Web, iOS, Android, and Admin consumers compatible.

Web retains Next.js application code, authentication/session integration, media
HTTP routes, and Vercel deployment. Do not classify all server-side Next.js code
as Backend code. Do not change or remove Web's consumed database type artifact.

No OpenAI moderation, new approval logic, or business-behavior changes. The
`moderation_automation_enabled` switch must remain disabled; do not query or change
hosted configuration under this repository-extraction authorization.

## Operational and repository safety

Deployment authority has not transferred from Web to Backend. No hosted Production
or Test operations are authorized during extraction: no SQL, migrations, resets,
Auth changes, Storage changes, Vault changes, worker activation, deployments, or
new Supabase projects/connections. No deployment workflows or credentials.

Do not modify Web, its worktrees, Admin, iOS, or Android. Preserve existing work.
Only the enumerated 82 source files and migration manifest may be added in Stage
1B, alongside necessary updates to the five Stage 1A files. Do not install
dependencies, execute copied code, repair tests, or refactor source. Never expose
credentials, tokens, private user data, or backup contents. Use credential-free
remote URLs; do not embed authentication material in source or configuration.

Report exact changed files, Git branch/base, commands and actual results. Separate
source inspection, local verification, and hosted acceptance. No claim of tests
passing unless those tests ran. Current documentation does not prove live service
state. Stop for CTO review at the authorized boundary.
