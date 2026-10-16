# Stage 2C-P1: partial static and unit CI implementation

This is a partial Stage 2C implementation prepared locally for CTO review. It is
not accepted full backend CI, database verification, production readiness or a
deployment handoff. The implementation baseline is
`495d6188b678587ab283e51a4aae1951e60c0197` on
`chore/backend-extraction-baseline`. The remote does not contain this working
branch; no push or hosted workflow execution is authorized by P1.

## Implemented foundation

`.github/workflows/backend-ci.yml` defines only `unit-integrity`, on Ubuntu 24.04,
with a 15-minute job timeout and explicit step timeouts. Proposed event wiring is
pull requests, pushes to main/the extraction branch and manual dispatch. This
local preparation does not activate those events or authorize a push.

Execution order:

1. Checkout with read-only contents permission and `persist-credentials: false`.
2. Set up Node 24.15.0; require pnpm 10.12.1 through Corepack and compare runtime
   and package pins against `scripts/ci/toolchain.json`.
3. Install with `corepack pnpm install --frozen-lockfile --ignore-scripts
   --engine-strict`. No lifecycle-script exceptions or lockfile updates.
4. Run `node scripts/ci/verify-baseline.mjs`: require raw manifest SHA-256
   `eb2dfee779a15634927cfbf25fcd6ffc59df591a585d1ec8f5f3d40e5caaf1dd`, then call
   the existing read-only migration verifier for exact 58-file membership and
   canonical file hashes. This does not execute migrations or SQL.
5. Run `corepack pnpm typecheck` with the existing TypeScript configuration.
6. Run `node --test scripts/ci/verification.test.mjs` for the new validators'
   acceptance/rejection and artifact privacy cases. Temporary migration copies
   are byte-check fixtures only; no database or SQL execution occurs.
7. First run `node scripts/ci/verify-unit-results.mjs --check-isolation` in the
   unit step; shell failure propagation prevents unit execution if it fails.
   Then run `corepack pnpm test:unit --reporter=default --reporter=json
   --outputFile=<runner-temp>/backend-unit-results.json` with an explicit
   PATH/HOME/CI/TMPDIR environment whitelist. Existing Vitest configuration keeps
   Node mode, `envDir: false`, exact discovery, zero-test rejection and the
   network-blocking setup. Test setup and test expectations are unchanged.
8. Validate the report and emit a sanitized summary. Require exactly the five
   configured filenames and 93 passing tests with these counts:

| Approved file | Passing tests |
| --- | ---: |
| src/__tests__/moderation-text-checker.test.ts | 39 |
| src/__tests__/moderation-target-guard.test.ts | 7 |
| src/__tests__/moderation-worker.test.ts | 10 |
| src/__tests__/moderation-worker-vault-auth.test.ts | 3 |
| tests/unit/email-outbox-worker.test.ts | 34 |

The validator inspects the literal `vitest.config.ts` include list and isolation
settings through the pinned TypeScript parser without executing the configuration.
It also pins the existing network setup's raw bytes. Report names must
be exact repository-relative paths or exact absolute paths within this checkout;
suffix-only matches are rejected. File/assertion statuses, totals and duplicate
identities are checked. Missing/malformed reports, failures, skips, pending/todo
tests, unexpected files or per-file count changes fail the job. Vitest 3's summary
suite counts include nested describe groups (26 in historical reports); the file
inventory is the five `testResults` records, not that nested suite count.

Neither unit execution nor report verification uses `continue-on-error`. Result
verification still runs after a failed test command and preserves the original
job failure. Only a sanitized summary is uploaded, including a generic failure
summary when validation fails. It contains fixed approved paths/counts/status,
never raw test names, messages, absolute paths or environment values. Raw JSON
remains temporary and is not uploaded. Missing expected artifacts fail upload;
retention is 14 days. No deployment secrets, environment, database services,
Supabase CLI, Docker steps or GitHub repository-setting changes are introduced.

## Toolchain evidence and limitations

`scripts/ci/toolchain.json` records Node 24.15.0, pnpm 10.12.1 and the existing
package versions: Supabase JS 2.116.0, Zod 3.24.2, TypeScript 5.9.3, Vitest 3.2.7
and Node declarations 20.19.43. Existing package/lock/configuration files remain
unchanged. Exact local runtime probes matched the proposed targets on 16 October
2026. The Stage 2A report supplies historical installation and unit evidence.

Action pins were verified on 16 October 2026 by credential-free, read-only
`git ls-remote --tags` queries of the named public repositories:

| Action | Tag | Verified commit |
| --- | --- | --- |
| actions/checkout | v4.2.2 | 11bd71901bbe5b1630ceea73d27597364c9af683 |
| actions/setup-node | v4.4.0 | 49933ea5288caeca8642d1e84afbd3f7d6820020 |
| actions/upload-artifact | v4.6.2 | ea165f8d65b6e75b540449e92b4886f43607fa02 |

These are verified tag-to-commit identities, not a claim that P1 ran those actions.
Linux optional binaries, Corepack/bootstrap availability, frozen installation on
Ubuntu 24.04, workflow execution and upload remain unverified until a separately
authorized hosted run. No Node/pnpm distribution digest is invented. There is no
fallback to a different runtime, dependency version or weaker installation flags.

## Local P1 verification (16 October 2026)

The following ran locally on Windows with Node 24.15.0 and pnpm 10.12.1:

| Command | Actual result |
| --- | --- |
| `corepack pnpm install --frozen-lockfile --ignore-scripts --engine-strict` | PASS; lockfile current, existing dependency tree already up to date; this was not a clean Linux installation |
| `node scripts/ci/verify-baseline.mjs` | PASS; approved manifest raw digest and all 58 canonical migration hashes |
| `corepack pnpm typecheck` | PASS |
| `node --test scripts/ci/verification.test.mjs` | PASS; 35 validator tests, zero failures/skips |
| `corepack pnpm test:unit --reporter=default --reporter=json --outputFile=artifacts/stage2c-p1-unit-results.json` | PASS; five files, 93 tests, zero failed/skipped/pending/todo |
| `node scripts/ci/verify-unit-results.mjs artifacts/stage2c-p1-unit-results.json --summary artifacts/stage2c-p1-sanitized/unit-summary.json` | PASS; exact filename/count mapping, sanitized summary generated |

Generated reports remain under ignored `artifacts/`; they are not source changes.
The installation emitted the existing Node DEP0169 `url.parse()` deprecation
warning. No flags were removed and no scripts enabled. Local checks do not prove
GitHub Actions YAML/runtime acceptance or the Linux environment-whitelist path;
those remain unexecuted. The workflow was inspected locally only.

## P1.1 isolation hardening (16 October 2026)

The pre-unit guard now requires exactly
`setupFiles: ["./tests/setup/no-network.ts"]`, `environment: "node"`,
`envDir: false`, `globals: false` and `passWithNoTests: false` as literal settings.
Missing, duplicate, computed or dynamic settings are rejected. Unreviewed root
or test options, including plugins, projects and per-file environment overrides,
are rejected because they could bypass the approved settings. Any encountered
`passWithNoTests` property with a non-literal-false value is rejected as well.

The existing `tests/setup/no-network.ts` was inspected without editing it. Its
raw SHA-256 is pinned in the validator and recorded in `toolchain.json`:
`c4a49badd88b567fa99b198f263f37308a16796bd026020522d29b0e2e95ce5f`.
The raw Git blob also matches `HEAD:tests/setup/no-network.ts`. Guard verification
checks both pin consistency and setup bytes, so altering the setup or changing
only the toolchain pin fails. Missing setup also fails. No newline normalization
is applied when hashing. Neither the config nor the setup file is modified.

The guard executes immediately before Vitest in the same fail-fast workflow
shell step and is repeated during post-run result verification. It runs without
importing the test configuration. The five-file/93-test contract, migration gate,
sanitized artifact schema, permissions, action pins and installation flags remain
unchanged. The workflow still contains only `unit-integrity`.

P1.1 local verification used Node 24.15.0 and pnpm 10.12.1:

| Command | Actual result |
| --- | --- |
| `node scripts/ci/verify-unit-results.mjs --check-isolation` | PASS before unit execution; settings and raw setup hash verified |
| `node --test scripts/ci/verification.test.mjs` | PASS; 58 tests, zero failures/skips; includes removed/changed setup, configuration overrides, pin drift and guard ordering |
| `node scripts/ci/verify-baseline.mjs` | PASS; approved manifest digest and 58 canonical migration hashes |
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm test:unit --reporter=default --reporter=json --outputFile=artifacts/stage2c-p11-unit-results.json` | PASS on filesystem-access rerun; five files, 93 passed, zero failed/skipped/pending/todo |
| `node scripts/ci/verify-unit-results.mjs artifacts/stage2c-p11-unit-results.json --summary artifacts/stage2c-p11-sanitized/unit-summary.json` | PASS; exact filenames/counts and sanitized summary |

The initial restricted-sandbox Vitest attempt failed before discovery because
esbuild could not read parent directories. The same command and pre-unit guard
then passed with approved filesystem access; no config, setup, flags or counts
were relaxed. Reports are ignored local artifacts. No packages were installed
for P1.1, and no hosted workflow was run.

Linux installation, Corepack bootstrap, workflow runtime acceptance, environment
whitelisting and artifact upload remain unverified. The guard protects the
reviewed literal configuration/setup contract; the existing network harness is
an in-process fetch/socket guard, not an operating-system network sandbox.
Runtime CLI arguments and future edits to the guard/workflow still require review.
Database/Linux egress isolation remains outside this partial implementation.

## Future database job: not implemented or authorized

A future separately approved `database-pg15` job must establish a fresh temporary
Supabase-compatible PostgreSQL 15 database, prove Linux host-port protection and
container egress isolation before loading migrations, reconstruct all 58 canonical
migrations and validate exact ledger membership. It must execute the nine
required pgTAP files explicitly, enforce their 270 assertions, perform read-only
RLS/private-bucket/Vault/worker-permission/disabled-moderation checks and verify
cleanup. No final required aggregation gate is implemented in P1.

Recorded database baselines are CLI 2.117.0, PostgreSQL 15.8, pg_net 0.14.0,
pg_cron 1.6 and supabase_vault 0.3.1. The recorded pg_prove 3.36 digest is
`sha256:eda7c5e68719e9c8287e78c017118407b48df904a51c935f5ab6098b8c0bc6bc`.
Exact database-image/Docker pins and usable Linux isolation remain unresolved;
P1 installs or starts none of these tools. No hosted credentials, production or
hosted Test target, worker activation or deployment may be introduced implicitly.

## Stage 2B exceptions retained

The accepted [Stage 2B record](STAGE2B_VERIFICATION.md) remains authoritative for
its local evidence and exceptions; static/unit CI does not revalidate that state:

- `schema_email_outbox.test.sql` remains historically excluded from required CI.
  The standalone diagnostic failed: unsupported `has_constraint` at line 59,
  34 planned versus 32 authored calls, and only 31 assertions executed. Its zero
  assertion failures are not a passing diagnostic. No test repair is included.
- Broad EXECUTE grants on `public.handle_listing_moderation_enqueue()` and
  `app_security.trg_fn_notify_moderation_worker()` require explicit authorization
  review and disposition before cutover. Their trigger return type means catalog
  grants alone do not establish ordinary RPC exploitability. No ACL changes.
- Loopback publication did not prove complete outbound isolation. Hosted
  end-to-end authorization, provider/worker delivery and deployment network
  controls remain separate acceptance prerequisites.
- Default Docker bridge IDs changed in some earlier runs; the cause remains
  unverified. P1 performs no Docker-state inspection or repair.

## Existing work and approval boundary

AGENTS.md, README.md, POINT1_BASELINE.md and DEPLOYMENT_OWNERSHIP.md retain their
pre-existing modified bytes, unstaged. Their older Stage 2B startup/authorization
text conflicts with later accepted evidence; reconciliation needs separate scope.
This file does not alter their deployment-ownership restrictions. P1 does not
change canonical migrations, SQL tests, copied unit tests, test setup, lockfile,
deployment configuration or application behavior. Stop for CTO review before
database CI, a final gate, any commit/push/PR or hosted execution.
