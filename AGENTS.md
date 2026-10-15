# FairSwap-Backend agent instructions

## Authority and current stage

Read `docs/extraction/POINT1_BASELINE.md` and
`docs/operations/DEPLOYMENT_OWNERSHIP.md` before work. Follow the latest explicit
human authorization; plans, repository files, and passing checks do not authorize
the next stage.

Stages 0, 1A and 1B are accepted. Stage 1A created the single README-only initial
commit `02ca486f903fb87e48da215bd1e6569fea14af1b` on `main`; do not repeat the
bootstrap or create additional commits on `main`.

Current authorization is Stage 2A only: create one local checkpoint of the reviewed
Stage 1A/1B baseline, establish the independent pinned TypeScript/Vitest toolchain,
copy exactly five approved unit tests unchanged, add a read-only migration verifier,
install dependencies and run scoped local checks. The checkpoint is
`47eabc28253951b733f607c61ed08bfa45e60248`. Work only on
`chore/backend-extraction-baseline`. Leave subsequent Stage 2A changes unstaged,
uncommitted and unpushed. No further commit, PR, or remote write is authorized.

Stop after Stage 2A for CTO review. Stage 2B, database integration, additional
test/script migration, CI migration, Web cleanup, deployment handoff, and later
implementation require separate authorization. No database/runtime test is
authorized by the unit-test permission.

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
Keep the 82 original source files and approved migration manifest immutable.
The only copied tests authorized in Stage 2A are moderation-text-checker,
moderation-target-guard, moderation-worker, moderation-worker-vault-auth under
`src/__tests__/` and `tests/unit/email-outbox-worker.test.ts`. Preserve their bytes
and expectations. Fix only configuration/dependency/test-harness issues; stop if a
failure requires changing production logic, tests, or database behavior. No Edge
entrypoint execution. Unit tests use mocked clients/transports with real network
access blocked, Node environment, explicit discovery, and no automatic env loading.
Never expose
credentials, tokens, private user data, or backup contents. Use credential-free
remote URLs; do not embed authentication material in source or configuration.

Report exact changed files, Git branch/base, commands and actual results. Separate
source inspection, local verification, and hosted acceptance. No claim of tests
passing unless those tests ran. Current documentation does not prove live service
state. Stop for CTO review at the authorized boundary.
